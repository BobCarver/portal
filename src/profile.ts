import type { User } from "./auth.ts";
import type { AppContext } from "./context.ts";
import { logEvent } from "./db.ts";
import { assertEntriesEligible } from "./categories.ts";
import { UserError } from "./errors.ts";
import { parseIsoDate } from "./http.ts";
import { type Gender, GENDERS, type Level, LEVELS } from "./eligibility.ts";

/**
 * A person's category details: gender, date of birth and amateur/professional
 * level (portal.md section 2). Only the person and the organisers see them.
 * They are never written into a bundle.
 */

export interface Profile {
  gender: Gender | null;
  /** ISO date. */
  date_of_birth: string | null;
  level: Level | null;
}

export async function profileOf(
  ctx: AppContext,
  userId: number,
): Promise<Profile> {
  const [row] = await ctx.sql<Profile[]>`
    SELECT gender, date_of_birth::text AS date_of_birth, level
    FROM users WHERE id = ${userId}`;
  return row ?? { gender: null, date_of_birth: null, level: null };
}

export function profileComplete(p: Profile): boolean {
  return p.gender !== null && p.date_of_birth !== null && p.level !== null;
}

/** A date of birth from the form: a real calendar date in the past, after 1900. */
export function parseBirthDate(text: string, today = new Date()): string {
  const dob = parseIsoDate(text, "date of birth");
  if (dob < "1900-01-01" || dob > today.toISOString().slice(0, 10)) {
    throw new UserError("Enter a date of birth in the past, after 1900.", 422);
  }
  return dob;
}

export async function updateProfile(
  ctx: AppContext,
  user: User,
  input: { gender: string; date_of_birth: string; level: string },
): Promise<void> {
  if (!GENDERS.includes(input.gender as Gender)) {
    throw new UserError("Choose male or female.", 422);
  }
  if (!LEVELS.includes(input.level as Level)) {
    throw new UserError("Choose amateur or professional.", 422);
  }
  const dob = parseBirthDate(input.date_of_birth);

  await ctx.sql.begin(async (tx) => {
    // Once a festival the person is entered in has its final bundle, nothing changes.
    const [{ locked }] = await tx<{ locked: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM entries e
        JOIN competitor_members m ON m.competitor_id = e.competitor_id
        JOIN competitions c ON c.id = e.competition_id
        JOIN exports x ON x.festival_id = c.festival_id AND x.final
        WHERE m.user_id = ${user.id}) AS locked`;
    if (locked) {
      throw new UserError(
        "A festival you are entered in has exported its final bundle; your details can no longer change.",
        409,
      );
    }
    await tx`UPDATE users SET gender = ${input.gender}, date_of_birth = ${dob},
      level = ${input.level} WHERE id = ${user.id}`;
    // Every entry of this person (through any of their competitors) must still agree.
    await assertEntriesEligible(tx, { userId: user.id }, "Those details");
    await logEvent(tx, {
      userId: user.id,
      kind: "profile.update",
      detail: `gender ${input.gender}, level ${input.level}`,
    });
  });
}
