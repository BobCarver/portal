import type { CompetitorType } from "festival-bundle";
import type { User } from "./auth.ts";
import { type AppContext, nowOf } from "./context.ts";
import { logEvent, type Tx } from "./db.ts";
import { UserError } from "./errors.ts";
import { assertEntriesEligible, eligibilityOf } from "./categories.ts";
import { festivalOf, type FestivalState, festivalState } from "./festival.ts";
import { closeGaps, nextOrder } from "./order.ts";

/** Competitors and entries: what competitors do (portal.md section 3). */

export const COMPETITOR_TYPES: CompetitorType[] = [
  "individual",
  "couple",
  "team",
];
const MAX_DURATION = 60 * 60;

export async function createCompetitor(
  ctx: AppContext,
  user: User,
  input: { name: string; type: string },
): Promise<number> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new UserError("Enter the competitor's name.", 422);
  if (!COMPETITOR_TYPES.includes(input.type as CompetitorType)) {
    throw new UserError("Choose individual, couple or team.", 422);
  }
  return await ctx.sql.begin(async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO competitors (name, type, created_by)
      VALUES (${name}, ${input.type}, ${user.id}) RETURNING id`;
    await tx`INSERT INTO competitor_members (competitor_id, user_id) VALUES (${row.id}, ${user.id})`;
    return row.id;
  });
}

export async function isMember(sql: Tx, userId: number, competitorId: number) {
  const [row] = await sql`SELECT 1 FROM competitor_members
    WHERE competitor_id = ${competitorId} AND user_id = ${userId}`;
  return !!row;
}

/** Members manage a competitor; organisers may too. */
export async function assertMember(sql: Tx, user: User, competitorId: number) {
  const [c] = await sql`SELECT id FROM competitors WHERE id = ${competitorId}`;
  if (!c) throw new UserError("No such competitor.", 404);
  if (!user.is_admin && !(await isMember(sql, user.id, competitorId))) {
    throw new UserError("You are not a member of this competitor.", 403);
  }
}

export async function updateCompetitor(
  ctx: AppContext,
  user: User,
  competitorId: number,
  input: { name: string; type: string },
) {
  await assertMember(ctx.sql, user, competitorId);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new UserError("Enter the competitor's name.", 422);
  if (!COMPETITOR_TYPES.includes(input.type as CompetitorType)) {
    throw new UserError("Choose individual, couple or team.", 422);
  }
  // The name and type are exported: they freeze with any festival entered.
  const frozen = await ctx.sql`
    SELECT 1 FROM entries e JOIN competitions c ON c.id = e.competition_id
      JOIN festivals f ON f.id = c.festival_id
    WHERE e.competitor_id = ${competitorId}
      AND (f.freeze_at <= now() OR EXISTS
        (SELECT 1 FROM exports x WHERE x.festival_id = f.id AND x.final))
    LIMIT 1`;
  if (frozen.length && !user.is_admin) {
    throw new UserError(
      "Registration has closed for a festival this competitor entered; ask the organiser.",
      409,
    );
  }
  await ctx.sql`UPDATE competitors SET name = ${name}, type = ${input.type}
    WHERE id = ${competitorId}`;
}

export async function addMember(
  ctx: AppContext,
  user: User,
  competitorId: number,
  email: string,
) {
  await assertMember(ctx.sql, user, competitorId);
  const [other] = await ctx.sql<{ id: number }[]>`
    SELECT id FROM users WHERE lower(email) = ${email.trim().toLowerCase()}`;
  if (!other) {
    throw new UserError(
      "No account uses that email. Ask them to register first.",
      404,
    );
  }
  await ctx.sql.begin(async (tx) => {
    await tx`SELECT id FROM competitors WHERE id = ${competitorId} FOR UPDATE`;
    const [p] = await tx<{ type: string; members: number }[]>`
      SELECT p.type, (SELECT count(*)::int FROM competitor_members m
        WHERE m.competitor_id = p.id) AS members
      FROM competitors p WHERE p.id = ${competitorId}`;
    if (p.type === "individual" && p.members >= 1) {
      throw new UserError(
        "An individual competitor has one member. Create a couple or a team instead.",
        409,
      );
    }
    if (p.type === "couple" && p.members >= 2) {
      throw new UserError("A couple has two members.", 409);
    }
    await tx`INSERT INTO competitor_members (competitor_id, user_id)
      VALUES (${competitorId}, ${other.id}) ON CONFLICT DO NOTHING`;
    await assertEntriesEligible(tx, { competitorId }, "That change");
  });
}

export async function removeMember(
  ctx: AppContext,
  user: User,
  competitorId: number,
  memberId: number,
) {
  await assertMember(ctx.sql, user, competitorId);
  await ctx.sql.begin(async (tx) => {
    await tx`SELECT id FROM competitors WHERE id = ${competitorId} FOR UPDATE`;
    const members = await tx`SELECT user_id FROM competitor_members
      WHERE competitor_id = ${competitorId}`;
    if (members.length <= 1) {
      throw new UserError("A competitor needs at least one member.", 409);
    }
    await tx`DELETE FROM competitor_members
      WHERE competitor_id = ${competitorId} AND user_id = ${memberId}`;
    await assertEntriesEligible(tx, { competitorId }, "That change");
  });
}

export function checkDuration(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_DURATION) {
    throw new UserError(
      "The duration must be between 1 second and 60 minutes.",
      422,
    );
  }
  return seconds;
}

/** Enter a competitor into a competition (once), at the end of the running order. */
export async function enter(
  ctx: AppContext,
  user: User,
  input: { competitorId: number; competitionId: number; duration: number },
): Promise<number> {
  await assertMember(ctx.sql, user, input.competitorId);
  checkDuration(input.duration);
  const festivalId = await festivalOf(
    ctx.sql,
    "competition",
    input.competitionId,
  );
  const state = await festivalState(ctx.sql, festivalId, nowOf(ctx));
  const [comp] = await ctx.sql<{ open: boolean }[]>`
    SELECT open FROM competitions WHERE id = ${input.competitionId}`;
  if (!user.is_admin && (!state.canEnter || !comp.open)) {
    throw new UserError("This competition is not open for entries.", 409);
  }
  if (user.is_admin && !state.adminCanEdit) {
    throw new UserError("The final bundle has been exported.", 409);
  }
  try {
    return await ctx.sql.begin(async (tx) => {
      // Serialise entries to one competition so order numbers do not collide,
      // and so its rules cannot change between the check and the insert.
      await tx`SELECT id FROM competitions WHERE id = ${input.competitionId} FOR UPDATE`;
      const problems = await eligibilityOf(
        tx,
        input.competitorId,
        input.competitionId,
      );
      if (problems.length) {
        throw new UserError(
          `This competitor cannot enter: ${problems.join("; ")}.`,
          409,
        );
      }
      const order = await nextOrder(tx, "entries", input.competitionId);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO entries (competition_id, competitor_id, duration, order_number)
        VALUES (${input.competitionId}, ${input.competitorId}, ${input.duration}, ${order})
        RETURNING id`;
      await logEvent(tx, {
        festivalId,
        userId: user.id,
        kind: "entry.create",
        detail:
          `entry ${row.id}: competitor ${input.competitorId} in competition ${input.competitionId}`,
      });
      return row.id;
    });
  } catch (err) {
    if (
      String((err as Error).message).includes(
        "entries_competition_id_competitor_id_key",
      )
    ) {
      throw new UserError(
        "This competitor has already entered that competition.",
        409,
      );
    }
    throw err;
  }
}

export interface EntryRow {
  id: number;
  competition_id: number;
  competitor_id: number;
  duration: number;
  order_number: number;
  created_at: Date;
  competition_name: string;
  competitor_name: string;
  competitor_type: CompetitorType;
  /** Null while the competition is not scheduled yet. */
  session_name: string | null;
  start_time: Date | null;
  track_name: string | null;
  festival_id: number;
  festival_name: string;
}

export async function loadEntry(sql: Tx, entryId: number): Promise<EntryRow> {
  const [e] = await sql<EntryRow[]>`
    SELECT e.id, e.competition_id, e.competitor_id, e.duration, e.order_number, e.created_at,
      c.name AS competition_name, p.name AS competitor_name, p.type AS competitor_type,
      s.name AS session_name, s.start_time, t.name AS track_name,
      f.id AS festival_id, f.name AS festival_name
    FROM entries e JOIN competitions c ON c.id = e.competition_id
      JOIN competitors p ON p.id = e.competitor_id
      JOIN festivals f ON f.id = c.festival_id
      LEFT JOIN sessions s ON s.id = c.session_id LEFT JOIN tracks t ON t.id = s.track_id
    WHERE e.id = ${entryId}`;
  if (!e) throw new UserError("No such entry.", 404);
  return e;
}

/**
 * An entry the user may act on, with what may change. Competitors edit until
 * the freeze; organisers until the final export.
 */
export async function entryForUser(
  ctx: AppContext,
  user: User,
  entryId: number,
): Promise<{ entry: EntryRow; state: FestivalState; canEdit: boolean }> {
  const entry = await loadEntry(ctx.sql, entryId);
  await assertMember(ctx.sql, user, entry.competitor_id);
  const state = await festivalState(ctx.sql, entry.festival_id, nowOf(ctx));
  const canEdit = user.is_admin ? state.adminCanEdit : state.competitorCanEdit;
  return { entry, state, canEdit };
}

export function assertCanEdit(x: { canEdit: boolean; state: FestivalState }) {
  if (!x.canEdit) {
    throw new UserError(
      x.state.final
        ? "The final bundle has been exported: nothing can change now."
        : "Registration is frozen: only the organiser can change entries now.",
      409,
    );
  }
}

export async function setDuration(
  ctx: AppContext,
  user: User,
  entryId: number,
  seconds: number,
) {
  const x = await entryForUser(ctx, user, entryId);
  assertCanEdit(x);
  checkDuration(seconds);
  await ctx.sql`UPDATE entries SET duration = ${seconds} WHERE id = ${entryId}`;
}

/** Withdraw (competitor) or remove (organiser) an entry; the order closes up. */
export async function withdraw(ctx: AppContext, user: User, entryId: number) {
  const x = await entryForUser(ctx, user, entryId);
  assertCanEdit(x);
  await ctx.sql.begin(async (tx) => {
    await tx`SELECT id FROM competitions WHERE id = ${x.entry.competition_id} FOR UPDATE`;
    await tx`DELETE FROM entries WHERE id = ${entryId}`;
    await closeGaps(tx, "entries", x.entry.competition_id);
    await logEvent(tx, {
      festivalId: x.entry.festival_id,
      userId: user.id,
      kind: user.is_admin ? "entry.remove" : "entry.withdraw",
      detail:
        `entry ${entryId}: ${x.entry.competitor_name} from ${x.entry.competition_name}`,
    });
  });
}
