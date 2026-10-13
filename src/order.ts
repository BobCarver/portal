import type { Tx } from "./db.ts";
import { UserError } from "./errors.ts";

/**
 * Strict running order (portal.md section 3): every session, competition and
 * entry has an `order_number`, 1..n without gaps or duplicates among its
 * siblings. New rows go last; reordering renumbers the whole level in one
 * transaction (the unique constraints are deferred to commit).
 */

export type Level = "sessions" | "competitions" | "entries";
const PARENT: Record<Level, string> = {
  sessions: "track_id",
  competitions: "session_id",
  entries: "competition_id",
};

/** The next number at a level (for a new row). */
export async function nextOrder(
  sql: Tx,
  level: Level,
  parentId: number,
): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT coalesce(max(order_number), 0) + 1 AS n FROM ${sql(level)}
    WHERE ${sql(PARENT[level])} = ${parentId}`;
  return r.n;
}

/** Ids of a level in running order. */
export async function idsInOrder(
  sql: Tx,
  level: Level,
  parentId: number,
): Promise<number[]> {
  const order = level === "sessions"
    ? sql`start_time, order_number, id`
    : sql`order_number, id`;
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM ${sql(level)} WHERE ${sql(PARENT[level])} = ${parentId}
    ORDER BY ${order}`;
  return rows.map((r) => r.id);
}

/** Number `ids` 1..n in the given order. `ids` must be the whole level. */
export async function renumber(
  sql: Tx,
  level: Level,
  parentId: number,
  ids: number[],
): Promise<void> {
  const current = await idsInOrder(sql, level, parentId);
  if (
    current.length !== ids.length || new Set(ids).size !== ids.length ||
    !ids.every((id) => current.includes(id))
  ) {
    throw new UserError(
      "The running order changed meanwhile; reload and try again.",
      409,
    );
  }
  if (ids.length === 0) return;
  await sql`
    UPDATE ${sql(level)} AS t SET order_number = v.n
    FROM unnest(${sql.array(ids)}::bigint[]) WITH ORDINALITY AS v(id, n)
    WHERE t.id = v.id`;
}

/** Close any gaps (after a delete), keeping the current order. */
export async function closeGaps(
  sql: Tx,
  level: Level,
  parentId: number,
): Promise<void> {
  await renumber(sql, level, parentId, await idsInOrder(sql, level, parentId));
}

/** `ids` with `id` moved to 1-based `position` (clamped). */
export function moveTo(ids: number[], id: number, position: number): number[] {
  const rest = ids.filter((x) => x !== id);
  if (rest.length === ids.length) return ids;
  const at = Math.max(0, Math.min(rest.length, Math.round(position) - 1));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Move `id` one place up (-1) or down (+1). */
export function moveBy(ids: number[], id: number, delta: -1 | 1): number[] {
  const i = ids.indexOf(id);
  return i < 0 ? ids : moveTo(ids, id, i + 1 + delta);
}
