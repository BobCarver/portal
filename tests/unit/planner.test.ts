import { assert, assertEquals } from "@std/assert";
import {
  compareVariants,
  competitionSeconds,
  judgeChanges,
  judgeGroups,
  makePlan,
  orderForJudges,
  type Plan,
  type PlanCompetition,
  type PlanEntry,
  type PlanSettings,
} from "../../src/plan/planner.ts";

const base: PlanSettings = {
  tracks: 1,
  sessionsPerTrack: 1,
  allowanceSeconds: 60,
  breakMinutes: 15,
  gapMinutes: 10,
  startsAt: new Date("2026-10-20T09:00:00Z"),
};

let nextId = 1;
/** An entry taking `minutes` in all (music plus the one-minute allowance). */
const entry = (minutes: number, people: number[] = []): PlanEntry => ({
  id: nextId++,
  seconds: minutes * 60 - 60,
  people,
});
const comp = (judges: number[], entries: PlanEntry[]): PlanCompetition => {
  const id = nextId++;
  return { id, name: `C${id}`, judges, entries };
};
/** A competition of one entry taking `minutes`, with these people in it. */
const single = (judges: number[], minutes: number, people: number[] = []) =>
  comp(judges, [entry(minutes, people)]);

/** When `person` performs, by competition (from the plan's estimated times). */
function timesOf(plan: Plan, comps: PlanCompetition[], person: number) {
  const out: { comp: number; track: number; at: number }[] = [];
  for (const s of plan.sessions) {
    for (const pc of s.competitions) {
      const c = comps.find((x) => x.id === pc.id)!;
      let at = pc.startsAt.getTime();
      for (const id of pc.entryIds) {
        const e = c.entries.find((x) => x.id === id)!;
        if (e.people.includes(person)) {
          out.push({ comp: c.id, track: s.track, at });
        }
        at += (e.seconds + base.allowanceSeconds) * 1000;
      }
    }
  }
  return out;
}

Deno.test("length: each entry's music plus one minute", () => {
  const c = comp([], [
    { id: 1, seconds: 120, people: [] },
    { id: 2, seconds: 180, people: [] },
  ]);
  assertEquals(competitionSeconds(c, 60), 120 + 60 + 180 + 60);
});

Deno.test("groups: competitions linked by any shared judge stay together", () => {
  const a = single([1, 2, 3], 10),
    b = single([4, 5, 6], 10),
    c = single([3, 7], 10);
  assertEquals(judgeGroups([a, b, c]), [[0, 2], [1]]);
});

Deno.test("order: same judges together, next panel as close as possible", () => {
  const a = single([1, 2, 3], 5),
    b = single([4, 5, 6], 5),
    c = single([1, 2, 3], 5),
    d = single([1, 2, 4], 5);
  const ordered = orderForJudges([a, b, c, d]);
  assertEquals(ordered.map((x) => x.id), [a.id, c.id, d.id, b.id]);
  assertEquals(judgeChanges(ordered), 2 + 4);
});

Deno.test("two separate panels go on two stages: no judge clashes or moves", () => {
  const cs = [
    single([1, 2, 3], 30),
    single([1, 2, 3], 30),
    single([4, 5, 6], 30),
    single([4, 5, 6], 30),
  ];
  const plan = makePlan(cs, { ...base, tracks: 2, sessionsPerTrack: 2 });
  assertEquals(plan.problems, []);
  assertEquals(plan.score.judgeClashes, 0);
  assertEquals(plan.score.judgeMoves, 0);
  assertEquals(plan.score.judgeChanges, 0);
  for (const s of plan.sessions) assertEquals(s.seconds, 30 * 60);
  const stageOf = (judge: number) =>
    new Set(
      plan.sessions.filter((s) => s.judges.includes(judge)).map((s) => s.track),
    );
  assertEquals(stageOf(1).size, 1, "panel 1 stays on one stage");
  assertEquals(stageOf(4).size, 1, "panel 2 stays on one stage");
});

Deno.test("one shared panel: only one stage can run, and the planner says so", () => {
  const cs = [single([1, 2, 3], 30), single([1, 2, 3], 30)];
  const plan = makePlan(cs, { ...base, tracks: 2, sessionsPerTrack: 1 });
  assertEquals(plan.score.judgeClashes, 0);
  assert(
    plan.problems.some((p) => p.includes("Only 1 stage(s) can run")),
    plan.problems.join("\n"),
  );
  assertEquals(new Set(plan.sessions.map((s) => s.track)).size, 1);
});

Deno.test("sessions on a stage are balanced", () => {
  const cs = [60, 50, 40, 30, 20, 10].map((m) => single([1], m));
  const plan = makePlan(cs, { ...base, sessionsPerTrack: 3 });
  assertEquals(plan.sessions.map((s) => s.seconds / 60).sort((a, b) => a - b), [
    70,
    70,
    70,
  ]);
});

Deno.test("parallel sessions are fine for someone whose performances are far apart", () => {
  // Dana (9) dances first on stage A and last on stage B: 40 minutes apart.
  const a = comp([1], [entry(5, [9]), entry(5), entry(5)]);
  const b = comp([2], [entry(15), entry(15), entry(10), entry(5, [9])]);
  const plan = makePlan([a, b], { ...base, tracks: 2 });
  assertEquals(plan.score.peopleClashes, 0);
  assertEquals(plan.score.entriesMoved, 0, "nothing needed to move");
  assertEquals(plan.sessions.length, 2, "both stages run in the same slot");
});

Deno.test("a clash is resolved by moving an entry within its competition", () => {
  // Dana is first in both competitions: both at 09:00 on different stages.
  const a = comp([1], [
    entry(5, [9]),
    entry(5, [1]),
    entry(5, [2]),
    entry(5, [3]),
  ]);
  const b = comp([2], [
    entry(5, [9]),
    entry(5, [4]),
    entry(5, [5]),
    entry(5, [6]),
  ]);
  const plan = makePlan([a, b], { ...base, tracks: 2 });
  assertEquals(plan.score.peopleClashes, 0, JSON.stringify(plan.clashes));
  assert(plan.score.entriesMoved >= 1);
  const [x, y] = timesOf(plan, [a, b], 9).map((t) => t.at).sort();
  assert(
    y - x >= (5 + 10) * 60_000,
    "at least her performance plus the gap apart",
  );
});

Deno.test("the gap is respected, and a gap of 0 needs no move", () => {
  // Dana performs 09:00-09:05 on stage A, and at 09:10 on stage B.
  const mk = () => [
    comp([1], [entry(5, [9]), entry(5), entry(5), entry(5)]),
    comp([2], [entry(10), entry(5, [9]), entry(5), entry(5)]),
  ];
  const tight = makePlan(mk(), { ...base, tracks: 2, gapMinutes: 10 });
  assertEquals(tight.score.peopleClashes, 0);
  assert(
    tight.score.entriesMoved >= 1,
    "5 minutes apart is too close for a 10-minute gap",
  );
  const loose = makePlan(mk(), { ...base, tracks: 2, gapMinutes: 0 });
  assertEquals(
    loose.score.entriesMoved,
    0,
    "with no gap, not overlapping is enough",
  );
});

Deno.test("a clash is resolved by moving a competition when its entries cannot move", () => {
  // Single-entry competitions, so only the order of competitions can help:
  // Dana's 5-minute entries are first on both stages, before 30-minute ones.
  const a1 = single([1], 5, [9]), a2 = single([1], 30, [1]);
  const b1 = single([2], 5, [9]), b2 = single([2], 30, [2]);
  const plan = makePlan([a1, a2, b1, b2], { ...base, tracks: 2 });
  assertEquals(plan.score.peopleClashes, 0, JSON.stringify(plan.clashes));
  const times = timesOf(plan, [a1, a2, b1, b2], 9).map((t) => t.at).sort();
  assert(
    times[1] - times[0] >= (5 + 10) * 60_000,
    "her performance plus the gap apart",
  );
  assertEquals(
    plan.score.entriesMoved,
    0,
    "no entry moved inside a competition",
  );
});

Deno.test("an unavoidable clash is reported, with who and when", () => {
  // One slot, one entry each, Dana in both: nothing can separate them.
  const a = single([1], 5, [9]), b = single([2], 5, [9]);
  const plan = makePlan([a, b], { ...base, tracks: 2 });
  assertEquals(plan.score.peopleClashes, 1);
  assertEquals(plan.clashes[0].person, 9);
  assert(
    plan.problems.some((p) => p.includes("less than 10 minutes apart")),
    plan.problems.join("\n"),
  );
});

Deno.test("times: parallel slots, a break after each, rounded up to 5 minutes", () => {
  const cs = [
    single([1], 62),
    single([1], 30),
    single([2], 40),
    single([2], 41),
  ];
  const plan = makePlan(cs, {
    ...base,
    tracks: 2,
    sessionsPerTrack: 2,
    breakMinutes: 15,
  });
  const starts = [
    ...new Set(plan.sessions.map((s) => s.startsAt.toISOString())),
  ].sort();
  // Slot 1 has the 62-minute session (09:00-10:02); + 15 min break = 10:17 -> 10:20.
  assertEquals(starts, [
    "2026-10-20T09:00:00.000Z",
    "2026-10-20T10:20:00.000Z",
  ]);
});

Deno.test("deterministic: the same input gives the same plan", () => {
  const cs = Array.from(
    { length: 20 },
    (_, i) =>
      comp([(i % 4) + 1], [
        entry(5 + (i * 7) % 23, [i % 5]),
        entry(4, [(i + 2) % 5]),
      ]),
  );
  const a = makePlan(cs, { ...base, tracks: 3, sessionsPerTrack: 3 });
  const b = makePlan(cs, { ...base, tracks: 3, sessionsPerTrack: 3 });
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("variants: best first; clash-free and without empty sessions ahead", () => {
  const cs = [
    single([1], 30),
    single([1], 30),
    single([2], 30),
    single([2], 30),
  ];
  const plans = compareVariants(cs, base, 3, 1, 3);
  assertEquals(plans.length, 9);
  const best = plans[0];
  assertEquals(best.score.emptySessions, 0);
  assertEquals(best.score.judgeClashes + best.score.peopleClashes, 0);
  assertEquals([best.settings.tracks, best.settings.sessionsPerTrack], [2, 1]);
});

Deno.test("a large festival: 120 competitions of 5 entries, three panels, 16 variants", () => {
  // No wall-clock limit: on a busy machine the same run can take far longer.
  const cs = Array.from({ length: 120 }, (_, i) =>
    comp(
      [[1, 2, 3], [4, 5, 6], [7, 8, 9]][i % 3],
      Array.from({ length: 5 }, (_, j) =>
        entry(2 + ((i + j) * 13) % 6, [(i * 5 + j) % 200])),
    ));
  const plans = compareVariants(cs, base, 4, 2, 5);
  assertEquals(plans.length, 16);
  const best = plans[0];
  assertEquals(best.score.judgeClashes, 0);
  assertEquals(best.score.judgeMoves, 0, "panels never change stage");
  assertEquals(
    best.sessions.reduce((n, s) => n + s.competitions.length, 0),
    120,
    "every competition is planned once",
  );
});
