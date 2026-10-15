import { assert, assertEquals } from "@std/assert";
import {
  ageOn,
  bandText,
  categoryOf,
  type CompetitionRules,
  eligibility,
  type EligibilityInput,
  type Member,
  rulesLabel,
} from "../../src/eligibility.ts";

const open: CompetitionRules = {
  gender: "open",
  level: "open",
  min_age: null,
  max_age: null,
};
const on = "2026-10-20";

const person = (
  name: string,
  gender: "male" | "female",
  dob: string,
  level: "amateur" | "professional",
): Member => ({ name, gender, date_of_birth: dob, level });

const solo = (
  m: Member,
  rules: Partial<CompetitionRules> = {},
): EligibilityInput => ({
  type: "individual",
  members: [m],
  competition: { ...open, ...rules },
  ageOn: on,
});

Deno.test("age: whole years, and the birthday itself counts", () => {
  assertEquals(ageOn("1990-10-20", "2026-10-20"), 36, "birthday today");
  assertEquals(ageOn("1990-10-21", "2026-10-20"), 35, "birthday tomorrow");
  assertEquals(ageOn("2008-02-29", "2026-02-28"), 17, "leap day birthday");
  assertEquals(ageOn("1990-12-31", "2026-01-01"), 35);
});

Deno.test("category: a couple is same-gender if its partners match, else mixed", () => {
  assertEquals(categoryOf("couple", ["female", "male"]), "mixed");
  assertEquals(categoryOf("couple", ["male", "male"]), "same_gender");
  assertEquals(categoryOf("couple", ["female", "female"]), "same_gender");
});

Deno.test("category: a team is men or women only if every member is", () => {
  assertEquals(categoryOf("team", ["male", "male", "male"]), "male");
  assertEquals(categoryOf("team", ["female"]), "female");
  assertEquals(categoryOf("team", ["male", "female"]), "mixed");
});

Deno.test("category: a soloist is male or female, never mixed", () => {
  assertEquals(categoryOf("individual", ["male"]), "male");
  assertEquals(categoryOf("individual", ["female"]), "female");
});

Deno.test("gender: a women's competition takes a woman, not a man", () => {
  const dana = person("Dana", "female", "1990-05-01", "amateur");
  const alex = person("Alex", "male", "1990-05-01", "amateur");
  assertEquals(eligibility(solo(dana, { gender: "female" })), []);
  const refused = eligibility(solo(alex, { gender: "female" }));
  assertEquals(refused.length, 1);
  assert(
    refused[0].includes("this competition is women, and the entry is men"),
    refused[0],
  );
});

Deno.test("gender: mixed and same-gender are for couples only", () => {
  const dana = person("Dana", "female", "1990-05-01", "amateur");
  const refused = eligibility(solo(dana, { gender: "mixed" }));
  assert(
    refused.some((p) => p.includes("Mixed couples is for couples only")),
    refused.join("\n"),
  );
});

Deno.test("gender: couples split into mixed and same-gender competitions", () => {
  const dana = person("Dana", "female", "1990-05-01", "amateur");
  const sam = person("Sam", "male", "1988-03-12", "amateur");
  const lou = person("Lou", "female", "1993-11-02", "amateur");
  const mixed = { type: "couple" as const, members: [dana, sam] };
  const same = { type: "couple" as const, members: [dana, lou] };
  assertEquals(
    eligibility({
      ...mixed,
      competition: { ...open, gender: "mixed" },
      ageOn: on,
    }),
    [],
  );
  assertEquals(
    eligibility({
      ...same,
      competition: { ...open, gender: "same_gender" },
      ageOn: on,
    }),
    [],
  );
  assert(
    eligibility({
      ...same,
      competition: { ...open, gender: "mixed" },
      ageOn: on,
    }).length > 0,
  );
  assert(
    eligibility({
      ...mixed,
      competition: { ...open, gender: "same_gender" },
      ageOn: on,
    }).length > 0,
  );
});

Deno.test("age: the band is inclusive, and every member must be in it", () => {
  const edge = person("Edge", "female", "1986-10-20", "amateur"); // 40 on the day
  const young = person("Young", "female", "2008-10-21", "amateur"); // 17 on the day
  assertEquals(eligibility(solo(edge, { min_age: 18, max_age: 40 })), []);
  assertEquals(eligibility(solo(edge, { max_age: 39 })).length, 1);
  assertEquals(eligibility(solo(young, { min_age: 18 })).length, 1);
  const pair = {
    type: "couple" as const,
    members: [edge, young],
    competition: { ...open, min_age: 18, max_age: 45 },
    ageOn: on,
  };
  const problems = eligibility(pair);
  assertEquals(problems.length, 1);
  assert(
    problems[0].startsWith("Young is not within the age band 18 to 45"),
    problems[0],
  );
});

Deno.test("age: a band needs the festival's age date, and open bounds are no limit", () => {
  const dana = person("Dana", "female", "1990-05-01", "amateur");
  const noDate = { ...solo(dana, { min_age: 18 }), ageOn: null };
  assert(eligibility(noDate).some((p) => p.includes("no age reference date")));
  assertEquals(
    eligibility({ ...solo(dana), ageOn: null }),
    [],
    "no band, no date needed",
  );
  assertEquals(eligibility(solo(dana, { min_age: 60 })).length, 1);
});

Deno.test("level: amateur and professional competitions take only their level", () => {
  const am = person("Am", "female", "1990-05-01", "amateur");
  const pro = person("Pro", "male", "1988-03-12", "professional");
  assertEquals(eligibility(solo(am, { level: "amateur" })), []);
  assertEquals(eligibility(solo(pro, { level: "amateur" })).length, 1);
  const pair = {
    type: "couple" as const,
    members: [am, pro],
    competition: { ...open, level: "amateur" as const },
    ageOn: on,
  };
  const problems = eligibility(pair);
  assertEquals(problems, [
    "Pro is professional, and this competition is amateur only",
  ]);
});

Deno.test("level: pro-am needs at least one professional and one amateur", () => {
  const am = person("Am", "female", "1990-05-01", "amateur");
  const pro = person("Pro", "male", "1988-03-12", "professional");
  const proam = { ...open, level: "pro_am" as const };
  assertEquals(
    eligibility({
      type: "couple",
      members: [am, pro],
      competition: proam,
      ageOn: on,
    }),
    [],
  );
  const twoAm = {
    type: "couple" as const,
    members: [am, am],
    competition: proam,
    ageOn: on,
  };
  assertEquals(eligibility(twoAm).length, 1);
  const twoPro = {
    type: "couple" as const,
    members: [pro, person("Pro2", "female", "1985-01-01", "professional")],
    competition: proam,
    ageOn: on,
  };
  assertEquals(eligibility(twoPro).length, 1);
});

Deno.test("level: an open competition takes any level", () => {
  const pro = person("Pro", "male", "1988-03-12", "professional");
  assertEquals(eligibility(solo(pro, { level: "open" })), []);
});

Deno.test("members: a couple has two people, a soloist one", () => {
  const dana = person("Dana", "female", "1990-05-01", "amateur");
  assertEquals(
    eligibility({
      type: "couple",
      members: [dana],
      competition: open,
      ageOn: on,
    }),
    ["a couple needs exactly two members"],
  );
  assertEquals(
    eligibility({
      type: "individual",
      members: [dana, dana],
      competition: open,
      ageOn: on,
    }),
    ["an individual competitor has exactly one member"],
  );
});

Deno.test("profile: missing details are named, and nothing else is judged", () => {
  const blank: Member = {
    name: "New Person",
    gender: null,
    date_of_birth: null,
    level: null,
  };
  const problems = eligibility(solo(blank, { gender: "female", min_age: 18 }));
  assertEquals(problems, [
    "New Person has not set gender, date of birth, amateur or professional in their profile",
  ]);
});

Deno.test("privacy: a refusal never shows a date of birth", () => {
  const young = person("Young", "female", "2008-10-21", "amateur");
  for (const p of eligibility(solo(young, { min_age: 18, max_age: 30 }))) {
    assert(!/\d{4}-\d{2}-\d{2}/.test(p), p);
  }
});

Deno.test("labels", () => {
  assertEquals(bandText(16, 18), "16 to 18");
  assertEquals(bandText(40, null), "from 40");
  assertEquals(bandText(null, 15), "up to 15");
  assertEquals(bandText(null, null), "(no limit)");
  assertEquals(
    rulesLabel({
      gender: "female",
      level: "amateur",
      min_age: 18,
      max_age: 40,
    }),
    "Women · Amateur · 18 to 40",
  );
  assertEquals(rulesLabel(open), "Open");
});
