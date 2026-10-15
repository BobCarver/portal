import { type AppContext } from "../context.ts";
import { logEvent, type Tx } from "../db.ts";
import { renumber } from "../order.ts";
import {
  makePlan,
  type Plan,
  type PlanCompetition,
  type PlanSettings,
} from "./planner.ts";

/**
 * The planner's database side: load a festival into `PlanCompetition`s and
 * write a chosen plan back as tracks, sessions and running order. Lengths come
 * from the cached `entries.duration` (set when the music was normalised), so
 * planning never runs ffmpeg or ffprobe.
 */

export interface PlanInput {
  /** Competitions with at least one entry: what gets planned. */
  competitions: PlanCompetition[];
  /** Competitions with no entries: left unscheduled. */
  withoutEntries: number;
  /** Entries whose music is not ready, so their length counts as 0. */
  withoutMusic: number;
  judges: { id: number; name: string }[];
  /** People entered, by user id (to name them in clashes). */
  people: Map<number, string>;
  /** The festival's tracks, in id order (stage 1 is the first). */
  tracks: { id: number; name: string }[];
}

export async function loadPlanInput(
  sql: Tx,
  festivalId: number,
): Promise<PlanInput> {
  const comps = await sql<{ id: number; name: string; rubric_id: number }[]>`
    SELECT c.id, c.name, c.rubric_id FROM competitions c
    WHERE c.festival_id = ${festivalId}
      AND EXISTS (SELECT 1 FROM entries e WHERE e.competition_id = c.id)
    ORDER BY c.id`;
  // Entries in their current running order, with their cached music length.
  const entries = await sql<
    { id: number; competition_id: number; duration: number }[]
  >`
    SELECT e.id, e.competition_id, e.duration
    FROM entries e JOIN competitions c ON c.id = e.competition_id
    WHERE c.festival_id = ${festivalId}
    ORDER BY e.competition_id, e.order_number, e.id`;
  const members = await sql<
    { entry_id: number; user_id: number; name: string }[]
  >`
    SELECT e.id AS entry_id, u.id AS user_id, u.name
    FROM entries e JOIN competitions c ON c.id = e.competition_id
      JOIN competitor_members m ON m.competitor_id = e.competitor_id
      JOIN users u ON u.id = m.user_id
    WHERE c.festival_id = ${festivalId}
    ORDER BY e.id, u.id`;
  const rubricJudges = await sql<{ rubric_id: number; judge_id: number }[]>`
    SELECT DISTINCT cr.rubric_id, jc.judge_id
    FROM judge_criteria jc JOIN criteria cr ON cr.id = jc.criterion_id
      JOIN rubrics r ON r.id = cr.rubric_id
    WHERE r.festival_id = ${festivalId}
    ORDER BY cr.rubric_id, jc.judge_id`;
  const [{ n: withoutEntries }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM competitions c
    WHERE c.festival_id = ${festivalId}
      AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.competition_id = c.id)`;

  const group = <T, K>(rows: T[], key: (r: T) => K) => {
    const m = new Map<K, T[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const judgesOf = group(rubricJudges, (r) => r.rubric_id);
  const entriesOf = group(entries, (e) => e.competition_id);
  const membersOf = group(members, (m) => m.entry_id);
  return {
    competitions: comps.map((c) => ({
      id: c.id,
      name: c.name,
      judges: (judgesOf.get(c.rubric_id) ?? []).map((r) => r.judge_id),
      entries: (entriesOf.get(c.id) ?? []).map((e) => ({
        id: e.id,
        seconds: e.duration,
        people: (membersOf.get(e.id) ?? []).map((m) => m.user_id),
      })),
    })),
    withoutEntries,
    withoutMusic: entries.filter((e) => e.duration === 0).length,
    judges: await sql<{ id: number; name: string }[]>`
      SELECT id, name FROM judges WHERE festival_id = ${festivalId} ORDER BY id`,
    people: new Map(members.map((m) => [m.user_id, m.name])),
    tracks: await sql<{ id: number; name: string }[]>`
      SELECT id, name FROM tracks WHERE festival_id = ${festivalId} ORDER BY id`,
  };
}

/**
 * Plan the festival with `settings` and write the result, in one transaction:
 * every session of the festival is replaced, competitions get their session
 * and running order, entries get their running order, and missing stages are
 * created ("Stage N"). Competitions without entries are left unscheduled. The
 * caller checks the festival may still change.
 */
export async function applyPlan(
  ctx: AppContext,
  festivalId: number,
  settings: PlanSettings,
  userId: number,
): Promise<Plan> {
  return await ctx.sql.begin(async (tx) => {
    await tx`SELECT id FROM festivals WHERE id = ${festivalId} FOR UPDATE`;
    const input = await loadPlanInput(tx, festivalId);
    const plan = makePlan(input.competitions, settings);

    // Stages: the first N tracks, created if there are not enough.
    const trackIds = input.tracks.map((t) => t.id);
    for (let t = trackIds.length; t < settings.tracks; t++) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO tracks (festival_id, name, location)
        VALUES (${festivalId}, ${`Stage ${t + 1}`}, '') RETURNING id`;
      trackIds.push(row.id);
    }

    // Replace the schedule: unschedule everything, drop the old sessions.
    await tx`UPDATE competitions SET session_id = NULL, order_number = NULL
      WHERE festival_id = ${festivalId}`;
    await tx`DELETE FROM sessions WHERE track_id IN
      (SELECT id FROM tracks WHERE festival_id = ${festivalId})`;

    const perTrack = new Map<number, number>();
    for (const s of plan.sessions) {
      const trackId = trackIds[s.track];
      const order = (perTrack.get(trackId) ?? 0) + 1;
      perTrack.set(trackId, order);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO sessions (track_id, name, start_time, order_number)
        VALUES (${trackId}, ${`Session ${s.slot + 1}`}, ${s.startsAt}, ${order})
        RETURNING id`;
      for (const [i, c] of s.competitions.entries()) {
        await tx`UPDATE competitions SET session_id = ${row.id}, order_number = ${
          i + 1
        }
          WHERE id = ${c.id} AND festival_id = ${festivalId}`;
        await renumber(tx, "entries", c.id, c.entryIds);
      }
    }
    await logEvent(tx, {
      festivalId,
      userId,
      kind: "plan.apply",
      detail:
        `${settings.tracks} stage(s) x ${settings.sessionsPerTrack} session(s): ` +
        `${plan.sessions.length} session(s), ${input.competitions.length} competition(s), ` +
        `${plan.score.entriesMoved} entr(ies) moved; judge changes ${plan.score.judgeChanges}, ` +
        `clashes ${plan.score.judgeClashes + plan.score.peopleClashes}`,
    });
    return plan;
  });
}
