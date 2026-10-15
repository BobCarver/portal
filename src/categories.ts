import type { Tx } from "./db.ts";
import { UserError } from "./errors.ts";
import {
  type CompetitionRules,
  type CompetitorType,
  eligibility,
  type Member,
} from "./eligibility.ts";

/**
 * The database side of eligibility: load a competitor's members and a
 * competition's rules, and run `eligibility` on them. Used by entering, by
 * changes to members or profiles, by changes to a competition's rules, and by
 * the enter form. (The exporter checks from its own snapshot.) Nothing here is
 * ever written into a bundle.
 */

/** Checks one competitor against any competition; the members are loaded once. */
export type Checker = (
  competition: CompetitionRules,
  ageOn: string | null,
) => string[];

export async function checkerFor(
  sql: Tx,
  competitorId: number,
): Promise<Checker> {
  const rows = await sql<(Member & { type: CompetitorType })[]>`
    SELECT p.type, u.name, u.gender, u.date_of_birth::text AS date_of_birth, u.level
    FROM competitors p
      JOIN competitor_members m ON m.competitor_id = p.id
      JOIN users u ON u.id = m.user_id
    WHERE p.id = ${competitorId}
    ORDER BY u.id`;
  const type = rows[0]?.type ?? "individual";
  const members = rows.map(({ name, gender, date_of_birth, level }) => ({
    name,
    gender,
    date_of_birth,
    level,
  }));
  return (competition, ageOn) =>
    eligibility({ type, members, competition, ageOn });
}

/** Why `competitorId` may not enter `competitionId`; empty = eligible. */
export async function eligibilityOf(
  sql: Tx,
  competitorId: number,
  competitionId: number,
): Promise<string[]> {
  const [c] = await sql<(CompetitionRules & { age_on: string | null })[]>`
    SELECT c.gender, c.level, c.min_age, c.max_age, f.age_on::text AS age_on
    FROM competitions c JOIN festivals f ON f.id = c.festival_id
    WHERE c.id = ${competitionId}`;
  if (!c) return ["no such competition"];
  return (await checkerFor(sql, competitorId))(c, c.age_on);
}

/** Which entries to re-check. */
export type EligibilityScope =
  | { competitorId: number }
  | { competitionId: number }
  | { userId: number }
  | { festivalId: number };

/**
 * Refuses (and so rolls back the surrounding transaction) if any entry in
 * `scope` no longer meets its competition's rules. Call it after the change
 * has been written, inside the same transaction; `what` names the change.
 */
export async function assertEntriesEligible(
  sql: Tx,
  scope: EligibilityScope,
  what: string,
): Promise<void> {
  const where = "competitorId" in scope
    ? sql`e.competitor_id = ${scope.competitorId}`
    : "competitionId" in scope
    ? sql`e.competition_id = ${scope.competitionId}`
    : "userId" in scope
    ? sql`e.competitor_id IN (SELECT competitor_id FROM competitor_members
        WHERE user_id = ${scope.userId})`
    : sql`c.festival_id = ${scope.festivalId}`;
  const rows = await sql<(CompetitionRules & {
    age_on: string | null;
    competitor_id: number;
    competitor_name: string;
    competition_name: string;
  })[]>`
    SELECT e.competitor_id, p.name AS competitor_name, c.name AS competition_name,
      c.gender, c.level, c.min_age, c.max_age, f.age_on::text AS age_on
    FROM entries e
      JOIN competitors p ON p.id = e.competitor_id
      JOIN competitions c ON c.id = e.competition_id
      JOIN festivals f ON f.id = c.festival_id
    WHERE ${where}
    ORDER BY e.id`;

  const checkers = new Map<number, Checker>();
  const problems: string[] = [];
  for (const r of rows) {
    if (!checkers.has(r.competitor_id)) {
      checkers.set(r.competitor_id, await checkerFor(sql, r.competitor_id));
    }
    const why = checkers.get(r.competitor_id)!(r, r.age_on);
    if (why.length) {
      problems.push(
        `${r.competitor_name} in ${r.competition_name}: ${why.join("; ")}`,
      );
    }
  }
  if (problems.length) {
    throw new UserError(
      `${what} would make an entry ineligible, so nothing was saved. ${
        problems.slice(0, 5).join(". ")
      }`,
      409,
    );
  }
}
