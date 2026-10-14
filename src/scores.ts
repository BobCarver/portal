import {
  checkScoresAgainstBundle,
  type FestivalData,
  type ScorePush,
  type ScoreRow,
  validateScorePush,
} from "festival-bundle";
import type { AppContext } from "./context.ts";
import { logEvent } from "./db.ts";

/**
 * The score receiver (portal.md section 9). The competition server POSTs the
 * festival's whole set of scores (and skips); the portal replaces that
 * festival's scores in one transaction, so missed pushes, corrections and
 * deletes need no special handling. The payload and its checks are the shared
 * contract in festival-bundle (`score-push.ts`), which the server sends with.
 */

export type ReceiveResult =
  | { status: 200; body: { ok: true; applied: boolean; reason?: string } }
  | {
    status: 400 | 403 | 409 | 422;
    body: { ok: false; error: string; details?: string[] };
  };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export async function receiveScores(
  ctx: AppContext,
  festivalId: number,
  raw: unknown,
): Promise<ReceiveResult> {
  const fail = async (
    status: 400 | 403 | 409 | 422,
    error: string,
    details?: string[],
  ): Promise<ReceiveResult> => {
    const p = isObj(raw) ? raw : {};
    await ctx.sql`INSERT INTO score_pushes (festival_id, accepted, error, final,
        bundle_digest, digest, score_count)
      VALUES (${festivalId}, false, ${
      [error, ...(details ?? [])].join("; ").slice(0, 2000)
    },
        ${p.final === true}, ${
      typeof p.bundle_digest === "string" ? p.bundle_digest : null
    },
        ${typeof p.digest === "string" ? p.digest : null},
        ${Array.isArray(p.scores) ? p.scores.length : null})`;
    await logEvent(ctx.sql, {
      festivalId,
      kind: "scores.rejected",
      detail: error,
    });
    return { status, body: { ok: false, error, details } };
  };

  const shape = validateScorePush(raw);
  if (shape.length) return fail(400, "the push is not valid", shape);
  const push = raw as ScorePush;
  if (push.festival_id !== festivalId) {
    return fail(
      403,
      `this token is for festival ${festivalId}, not ${push.festival_id}`,
    );
  }

  // The bundle the scores belong to: the final export once there is one,
  // otherwise any export (a dry run at the venue).
  const exports = await ctx.sql<
    { digest: string; final: boolean; data_text: string }[]
  >`
    SELECT digest, final, data_text FROM exports WHERE festival_id = ${festivalId}
    ORDER BY final DESC, generated_at DESC`;
  const finalExport = exports.find((x) => x.final);
  const match = finalExport
    ? (finalExport.digest === push.bundle_digest ? finalExport : undefined)
    : exports.find((x) => x.digest === push.bundle_digest);
  if (!match) {
    return fail(
      409,
      finalExport
        ? "the scores belong to a different bundle than the final export"
        : "the scores belong to a bundle this portal did not export",
    );
  }
  const refs = checkScoresAgainstBundle(push, JSON.parse(match.data_text));
  if (refs.length) return fail(422, "the scores do not match the bundle", refs);

  const sentAt = new Date(push.sent_at);
  return await ctx.sql.begin(async (tx): Promise<ReceiveResult> => {
    // One push at a time per festival; an older snapshot never overwrites a newer one.
    await tx`SELECT id FROM festivals WHERE id = ${festivalId} FOR UPDATE`;
    const [last] = await tx<{ sent_at: Date; final: boolean }[]>`
      SELECT sent_at, final FROM score_pushes
      WHERE festival_id = ${festivalId} AND accepted AND sent_at IS NOT NULL
      ORDER BY sent_at DESC LIMIT 1`;
    if (last && last.sent_at > sentAt) {
      await tx`INSERT INTO score_pushes (festival_id, accepted, error, final,
          bundle_digest, digest, sent_at, score_count, skip_count)
        VALUES (${festivalId}, true, 'stale: a newer push was already applied',
          ${push.final}, ${push.bundle_digest}, ${push.digest}, ${sentAt},
          ${push.scores.length}, ${push.skips.length})`;
      return {
        status: 200,
        body: { ok: true, applied: false, reason: "stale" },
      };
    }

    await tx`DELETE FROM scores WHERE festival_id = ${festivalId}`;
    await tx`DELETE FROM skips WHERE festival_id = ${festivalId}`;
    for (let i = 0; i < push.scores.length; i += 5000) {
      const rows = push.scores.slice(i, i + 5000).map((r) => ({
        festival_id: festivalId,
        competition_id: r.competition_id,
        competitor_id: r.competitor_id,
        judge_id: r.judge_id,
        criteria_id: r.criteria_id,
        score: r.score,
      }));
      await tx`INSERT INTO scores ${tx(rows)}`;
    }
    for (let i = 0; i < push.skips.length; i += 5000) {
      const rows = push.skips.slice(i, i + 5000).map((r) => ({
        festival_id: festivalId,
        session_id: r.session_id,
        competition_id: r.competition_id,
        competitor_id: r.competitor_id,
        stage: r.stage,
        actor: r.actor,
        reason: r.reason,
      }));
      await tx`INSERT INTO skips ${tx(rows)}`;
    }
    await tx`INSERT INTO score_pushes (festival_id, accepted, final, bundle_digest,
        digest, sent_at, score_count, skip_count)
      VALUES (${festivalId}, true, ${push.final}, ${push.bundle_digest}, ${push.digest},
        ${sentAt}, ${push.scores.length}, ${push.skips.length})`;
    await logEvent(tx, {
      festivalId,
      kind: push.final ? "scores.final" : "scores.push",
      detail:
        `${push.scores.length} score(s), ${push.skips.length} skip(s), digest ${push.digest}`,
    });
    return { status: 200, body: { ok: true, applied: true } };
  });
}

/** Weighted results per competition, for the results view. */
export interface ResultRow {
  competition_id: number;
  competitor_id: number;
  /** Sum over judges and criteria of score x weight. */
  total: number;
  /** judge id -> criterion id -> score */
  scores: Map<number, Map<number, number>>;
}

export function tallyResults(
  data: FestivalData,
  scores: ScoreRow[],
): Map<number, ResultRow[]> {
  const weight = new Map<number, number>();
  for (const r of data.festival.rubrics) {
    for (const c of r.criteria) weight.set(c.id, c.weight);
  }
  const rows = new Map<string, ResultRow>();
  for (const s of scores) {
    const key = `${s.competition_id}/${s.competitor_id}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        competition_id: s.competition_id,
        competitor_id: s.competitor_id,
        total: 0,
        scores: new Map(),
      };
      rows.set(key, row);
    }
    row.total += Number(s.score) * (weight.get(s.criteria_id) ?? 1);
    const byJudge = row.scores.get(s.judge_id) ?? new Map<number, number>();
    byJudge.set(s.criteria_id, Number(s.score));
    row.scores.set(s.judge_id, byJudge);
  }
  const out = new Map<number, ResultRow[]>();
  for (const row of rows.values()) {
    row.total = Math.round(row.total * 100) / 100;
    out.set(row.competition_id, [...(out.get(row.competition_id) ?? []), row]);
  }
  for (const list of out.values()) list.sort((a, b) => b.total - a.total);
  return out;
}
