import type { Tx } from "./db.ts";
import { UserError } from "./errors.ts";

export interface FestivalRow {
  id: number;
  name: string;
  registration_open: boolean;
  freeze_at: Date | null;
  order_published: boolean;
  api_token_hash: string | null;
  created_at: Date;
  /** The date ages are worked out on (ISO), or null. */
  age_on: string | null;
}

/**
 * What may change now (portal.md section 8):
 * - competitors enter while registration is open and before the freeze;
 * - competitors upload, replace and withdraw until the freeze;
 * - admins may change anything until the final export, after which nothing
 *   changes (the bundle is final).
 */
export interface FestivalState {
  festival: FestivalRow;
  frozen: boolean;
  /** A final export exists. */
  final: boolean;
  canEnter: boolean;
  competitorCanEdit: boolean;
  adminCanEdit: boolean;
}

export async function festivalState(
  sql: Tx,
  festivalId: number,
  now = new Date(),
): Promise<FestivalState> {
  const [f] = await sql<(FestivalRow & { final: boolean })[]>`
    SELECT f.id, f.name, f.registration_open, f.freeze_at, f.order_published,
      f.api_token_hash, f.created_at, to_char(f.age_on, 'YYYY-MM-DD') AS age_on,
      EXISTS (SELECT 1 FROM exports x WHERE x.festival_id = f.id AND x.final) AS final
    FROM festivals f WHERE f.id = ${festivalId}`;
  if (!f) throw new UserError("No such festival.", 404);
  const { final, ...festival } = f;
  const frozen = festival.freeze_at !== null && festival.freeze_at <= now;
  return {
    festival,
    frozen,
    final,
    canEnter: festival.registration_open && !frozen && !final,
    competitorCanEdit: !frozen && !final,
    adminCanEdit: !final,
  };
}

export function assertAdminCanEdit(s: FestivalState): void {
  if (!s.adminCanEdit) {
    throw new UserError(
      "The final bundle has been exported: this festival can no longer change.",
      409,
    );
  }
}

/** The festival a row belongs to, walking up the structure. */
export async function festivalOf(
  sql: Tx,
  what:
    | "track"
    | "session"
    | "competition"
    | "entry"
    | "rubric"
    | "criterion"
    | "judge",
  id: number,
): Promise<number> {
  const rows = await (() => {
    switch (what) {
      case "track":
        return sql`SELECT festival_id FROM tracks WHERE id = ${id}`;
      case "session":
        return sql`SELECT t.festival_id FROM sessions s JOIN tracks t ON t.id = s.track_id
          WHERE s.id = ${id}`;
      case "competition":
        return sql`SELECT festival_id FROM competitions WHERE id = ${id}`;
      case "entry":
        return sql`SELECT c.festival_id FROM entries e JOIN competitions c ON c.id = e.competition_id
          WHERE e.id = ${id}`;
      case "rubric":
        return sql`SELECT festival_id FROM rubrics WHERE id = ${id}`;
      case "criterion":
        return sql`SELECT r.festival_id FROM criteria c JOIN rubrics r ON r.id = c.rubric_id
          WHERE c.id = ${id}`;
      case "judge":
        return sql`SELECT festival_id FROM judges WHERE id = ${id}`;
    }
  })();
  if (!rows[0]) throw new UserError(`No such ${what}.`, 404);
  return Number(rows[0].festival_id);
}

/** UTC ISO without milliseconds when they are zero: `2026-10-20T18:00:00Z`. */
export function utcIso(d: Date): string {
  return d.toISOString().replace(".000Z", "Z");
}
