import type { FestivalData } from "festival-bundle";
import type { AppContext } from "./context.ts";
import { logEvent } from "./db.ts";

/**
 * The score receiver (portal.md section 9). The competition server POSTs the
 * festival's whole set of scores (and skips); the portal replaces that
 * festival's scores in one transaction, so missed pushes, corrections and
 * deletes need no special handling. The shape matches `CloudPayload` in the
 * competition server's `cloudPush.ts`.
 */

export interface ScoreRow {
  competition_id: number;
  competitor_id: number;
  judge_id: number;
  criteria_id: number;
  score: number;
}

export interface SkipRow {
  session_id: number;
  competition_id: number;
  competitor_id: number;
  stage: string;
  actor: string;
  reason: string;
}

export interface ScorePush {
  festival_id: number;
  bundle_digest: string;
  digest: string;
  final: boolean;
  sent_at: string;
  scores: ScoreRow[];
  skips: SkipRow[];
}

export type ReceiveResult =
  | { status: 200; body: { ok: true; applied: boolean; reason?: string } }
  | {
    status: 400 | 403 | 409 | 422;
    body: { ok: false; error: string; details?: string[] };
  };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) > 0;

/** Shape checks; returns readable problems (empty = valid). */
export function checkPush(raw: unknown): string[] {
  if (!isObj(raw)) return ["body must be a JSON object"];
  const bad: string[] = [];
  if (!isId(raw.festival_id)) {
    bad.push("festival_id must be a positive integer");
  }
  for (const k of ["bundle_digest", "digest", "sent_at"]) {
    if (typeof raw[k] !== "string" || raw[k] === "") {
      bad.push(`${k} must be text`);
    }
  }
  if (
    typeof raw.sent_at === "string" && Number.isNaN(Date.parse(raw.sent_at))
  ) {
    bad.push("sent_at must be an ISO time");
  }
  if (typeof raw.final !== "boolean") bad.push("final must be true or false");
  if (!Array.isArray(raw.scores)) bad.push("scores must be a list");
  if (raw.skips !== undefined && !Array.isArray(raw.skips)) {
    bad.push("skips must be a list");
  }
  if (bad.length) return bad;

  const seen = new Set<string>();
  for (const [i, r] of (raw.scores as unknown[]).entries()) {
    if (bad.length >= 20) break;
    if (
      !isObj(r) || !isId(r.competition_id) || !isId(r.competitor_id) ||
      !isId(r.judge_id) || !isId(r.criteria_id)
    ) {
      bad.push(`scores[${i}]: ids must be positive integers`);
      continue;
    }
    const s = r.score;
    if (
      typeof s !== "number" || s < 1 || s > 10 ||
      Math.abs(Math.round(s * 10) - s * 10) > 1e-6
    ) {
      bad.push(`scores[${i}]: score must be 1-10 with at most one decimal`);
    }
    const key =
      `${r.competition_id}/${r.competitor_id}/${r.judge_id}/${r.criteria_id}`;
    if (seen.has(key)) bad.push(`scores[${i}]: ${key} is listed twice`);
    seen.add(key);
  }
  for (const [i, r] of ((raw.skips as unknown[]) ?? []).entries()) {
    if (bad.length >= 20) break;
    if (
      !isObj(r) || !isId(r.session_id) || !isId(r.competition_id) ||
      !isId(r.competitor_id) || typeof r.stage !== "string" ||
      typeof r.actor !== "string" || typeof r.reason !== "string"
    ) {
      bad.push(
        `skips[${i}]: needs session_id, competition_id, competitor_id, stage, actor, reason`,
      );
    }
  }
  return bad;
}

/** Rows that do not belong to the bundle (unknown entry, judge or criterion). */
export function checkAgainstBundle(
  push: ScorePush,
  data: FestivalData,
): string[] {
  const rubrics = new Map(data.festival.rubrics.map((r) => [r.id, r]));
  const entries = new Set<string>();
  const scorable = new Map<number, Set<string>>(); // competition -> judge/criterion
  for (const t of data.festival.tracks) {
    for (const s of t.sessions) {
      for (const c of s.competitions) {
        for (const p of c.competitors) entries.add(`${c.id}/${p.id}`);
        const pairs = new Set<string>();
        for (const j of rubrics.get(c.rubric_id)?.judges ?? []) {
          for (const k of j.criteria) pairs.add(`${j.id}/${k}`);
        }
        scorable.set(c.id, pairs);
      }
    }
  }
  const bad: string[] = [];
  for (const r of push.scores) {
    if (bad.length >= 20) break;
    const where =
      `score ${r.competition_id}/${r.competitor_id}/${r.judge_id}/${r.criteria_id}`;
    if (!entries.has(`${r.competition_id}/${r.competitor_id}`)) {
      bad.push(
        `${where}: competitor ${r.competitor_id} is not in competition ${r.competition_id}`,
      );
    } else if (
      !scorable.get(r.competition_id)?.has(`${r.judge_id}/${r.criteria_id}`)
    ) {
      bad.push(
        `${where}: judge ${r.judge_id} does not score criterion ${r.criteria_id} there`,
      );
    }
  }
  return bad;
}

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

  const shape = checkPush(raw);
  if (shape.length) return fail(400, "the push is not valid", shape);
  const push = raw as unknown as ScorePush;
  push.skips ??= [];
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
  const refs = checkAgainstBundle(push, JSON.parse(match.data_text));
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
