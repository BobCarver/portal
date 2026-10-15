/**
 * Who may enter which competition: gender, age and amateur/professional level.
 * Pure functions, no database, so the rules are unit-tested directly. Every
 * place that adds or changes an entry, a member, a profile or a competition's
 * rules calls `eligibility` (see entries.ts and profile.ts), and the exporter
 * calls it again before writing a bundle.
 *
 * Rules (the organiser's decisions):
 * - A person is male or female. Their profile also needs a date of birth and
 *   an amateur/professional level.
 * - A competitor's category follows its members. A couple is `same_gender` if
 *   both partners share a gender, otherwise `mixed`. A team is `male` or
 *   `female` if every member is, otherwise `mixed`. An individual is their own.
 * - A competition takes one category, or `open` for any.
 *   `mixed` and `same_gender` are for couples only.
 * - Every member must be inside the competition's age band (inclusive, either
 *   bound optional) on the festival's age reference date.
 * - Level: an `amateur` or `professional` competition takes only members of
 *   that level. A `pro_am` competition takes a mix: at least one professional
 *   and at least one amateur. `open` takes anyone.
 */

export type Gender = "male" | "female";
export type Level = "amateur" | "professional";
export type CompetitorType = "individual" | "couple" | "team";
export type CompetitionGender =
  | "male"
  | "female"
  | "mixed"
  | "same_gender"
  | "open";
export type CompetitionLevel = "amateur" | "professional" | "pro_am" | "open";
export type CompetitorCategory = "male" | "female" | "mixed" | "same_gender";

export const GENDERS: readonly Gender[] = ["male", "female"];
export const LEVELS: readonly Level[] = ["amateur", "professional"];
export const COMPETITION_GENDERS: readonly CompetitionGender[] = [
  "open",
  "male",
  "female",
  "mixed",
  "same_gender",
];
export const COMPETITION_LEVELS: readonly CompetitionLevel[] = [
  "open",
  "amateur",
  "professional",
  "pro_am",
];

export const GENDER_LABEL: Record<CompetitionGender, string> = {
  open: "Open",
  male: "Men",
  female: "Women",
  mixed: "Mixed couples",
  same_gender: "Same-gender couples",
};
export const LEVEL_LABEL: Record<CompetitionLevel, string> = {
  open: "Open level",
  amateur: "Amateur",
  professional: "Professional",
  pro_am: "Pro-am",
};

/** One member's profile, as the rules need it. */
export interface Member {
  name: string;
  gender: Gender | null;
  /** ISO date, `YYYY-MM-DD`. */
  date_of_birth: string | null;
  level: Level | null;
}

export interface CompetitionRules {
  gender: CompetitionGender;
  level: CompetitionLevel;
  min_age: number | null;
  max_age: number | null;
}

export interface EligibilityInput {
  type: CompetitorType;
  members: Member[];
  competition: CompetitionRules;
  /** The festival's age reference date (ISO date), or null if not set. */
  ageOn: string | null;
}

/** Whole years from `dob` to `on` (both ISO dates). */
export function ageOn(dob: string, on: string): number {
  const [y1, m1, d1] = dob.split("-").map(Number);
  const [y2, m2, d2] = on.split("-").map(Number);
  let age = y2 - y1;
  if (m2 < m1 || (m2 === m1 && d2 < d1)) age--;
  return age;
}

/** The category a competitor falls into, from its members' genders. */
export function categoryOf(
  type: CompetitorType,
  genders: Gender[],
): CompetitorCategory {
  if (type === "couple") {
    return genders[0] === genders[1] ? "same_gender" : "mixed";
  }
  if (genders.every((g) => g === "male")) return "male";
  if (genders.every((g) => g === "female")) return "female";
  return "mixed";
}

const isIsoDate = (v: string | null): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Why this competitor may not enter this competition, as readable sentences.
 * Empty = eligible. Never mentions a date of birth; ages are only named in the
 * band itself.
 */
export function eligibility(input: EligibilityInput): string[] {
  const { type, members, competition: rules, ageOn: on } = input;
  const problems: string[] = [];

  // The category needs the right number of people.
  if (type === "individual" && members.length !== 1) {
    problems.push("an individual competitor has exactly one member");
  }
  if (type === "couple" && members.length !== 2) {
    problems.push("a couple needs exactly two members");
  }
  if (type === "team" && members.length < 1) {
    problems.push("a team needs at least one member");
  }

  // Every member's profile must be complete before anything else can be judged.
  const incomplete = members.filter((m) =>
    m.gender === null || !isIsoDate(m.date_of_birth) || m.level === null
  );
  for (const m of incomplete) {
    const missing = [
      m.gender === null && "gender",
      !isIsoDate(m.date_of_birth) && "date of birth",
      m.level === null && "amateur or professional",
    ].filter(Boolean);
    problems.push(
      `${m.name} has not set ${missing.join(", ")} in their profile`,
    );
  }
  if (incomplete.length > 0) return problems;

  // Gender: the competitor's category against the competition's.
  if (
    (rules.gender === "mixed" || rules.gender === "same_gender") &&
    type !== "couple"
  ) {
    problems.push(`${GENDER_LABEL[rules.gender]} is for couples only`);
  }
  const category = categoryOf(type, members.map((m) => m.gender!));
  if (rules.gender !== "open" && rules.gender !== category) {
    problems.push(
      `this competition is ${
        GENDER_LABEL[rules.gender].toLowerCase()
      }, and the entry is ${CATEGORY_TEXT[category]}`,
    );
  }

  // Level: amateur and professional take only their own level; pro-am takes
  // at least one of each; open takes anyone.
  if (rules.level === "pro_am") {
    const pros = members.filter((m) => m.level === "professional").length;
    const ams = members.filter((m) => m.level === "amateur").length;
    if (pros === 0 || ams === 0) {
      problems.push(
        "a pro-am competition needs at least one professional and at least one amateur",
      );
    }
  } else if (rules.level !== "open") {
    const off = members.filter((m) => m.level !== rules.level);
    for (const m of off) {
      problems.push(
        `${m.name} is ${m.level}, and this competition is ${rules.level} only`,
      );
    }
  }

  // Age: every member, on the festival's reference date.
  const bounded = rules.min_age !== null || rules.max_age !== null;
  if (bounded) {
    if (!isIsoDate(on)) {
      problems.push("the festival has no age reference date yet");
    } else {
      const band = bandText(rules.min_age, rules.max_age);
      for (const m of members) {
        const age = ageOn(m.date_of_birth!, on);
        if (
          (rules.min_age !== null && age < rules.min_age) ||
          (rules.max_age !== null && age > rules.max_age)
        ) {
          problems.push(`${m.name} is not within the age band ${band}`);
        }
      }
    }
  }
  return problems;
}

const CATEGORY_TEXT: Record<CompetitorCategory, string> = {
  male: "men",
  female: "women",
  mixed: "mixed",
  same_gender: "same-gender",
};

/** "16 to 18", "from 40", "up to 15", or "(no limit)". */
export function bandText(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${min} to ${max}`;
  if (min !== null) return `from ${min}`;
  if (max !== null) return `up to ${max}`;
  return "(no limit)";
}

/** A short label for a competition's rules, for lists: "Men · Amateur · 16 to 18". */
export function rulesLabel(rules: CompetitionRules): string {
  const parts = [GENDER_LABEL[rules.gender]];
  if (rules.level !== "open") parts.push(LEVEL_LABEL[rules.level]);
  if (rules.min_age !== null || rules.max_age !== null) {
    parts.push(bandText(rules.min_age, rules.max_age));
  }
  return parts.join(" · ");
}
