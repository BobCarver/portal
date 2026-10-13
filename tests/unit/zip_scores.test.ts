import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FestivalData } from "festival-bundle";
import { crc32, writeStoredZip } from "../../src/export/zip.ts";
import {
  checkAgainstBundle,
  checkPush,
  type ScorePush,
  tallyResults,
} from "../../src/scores.ts";

Deno.test("zip: crc32 check value", () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

Deno.test("zip: stored (no compression), readable by unzip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
    await Deno.writeFile(`${dir}/a.bin`, big);
    await writeStoredZip(`${dir}/x.zip`, [
      { name: "b/manifest.json", data: new TextEncoder().encode("{}\n") },
      { name: "b/audio/a.bin", path: `${dir}/a.bin` },
    ], new Date("2026-10-20T18:00:00Z"));
    const test = await new Deno.Command("unzip", {
      args: ["-tv", `${dir}/x.zip`],
      stdout: "piped",
    }).output();
    const out = new TextDecoder().decode(test.stdout);
    assert(test.success, out);
    assertStringIncludes(out, "No errors detected");
    const list = await new Deno.Command("unzip", {
      args: ["-v", `${dir}/x.zip`],
      stdout: "piped",
    }).output();
    const listing = new TextDecoder().decode(list.stdout);
    assertStringIncludes(listing, "Stored");
    assert(!listing.includes("Defl"), listing);
    const size = (await Deno.stat(`${dir}/x.zip`)).size;
    assert(size > big.length, "stored, so at least as large as the content");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const DATA: FestivalData = {
  festival: {
    id: 1,
    name: "F",
    rubrics: [{
      id: 1,
      name: "R",
      criteria: [{ id: 1, name: "T", weight: 1 }, {
        id: 2,
        name: "M",
        weight: 2,
      }],
      judges: [{ id: 7, name: "A", criteria: [1, 2] }, {
        id: 8,
        name: "B",
        criteria: [1],
      }],
    }],
    tracks: [{
      id: 1,
      name: "T",
      location: "",
      sessions: [{
        id: 10,
        name: "S",
        start_time: "2026-10-20T18:00:00Z",
        order_number: 1,
        competitions: [{
          id: 100,
          name: "C",
          order_number: 1,
          rubric_id: 1,
          competitors: [
            {
              id: 1001,
              name: "X",
              type: "individual",
              order_number: 1,
              duration: 60,
              audio: {},
            },
            {
              id: 1002,
              name: "Y",
              type: "individual",
              order_number: 2,
              duration: 60,
              audio: {},
            },
          ],
        }],
      }],
    }],
  },
};

const push = (scores: ScorePush["scores"]): ScorePush => ({
  festival_id: 1,
  bundle_digest: "d",
  digest: "x",
  final: false,
  sent_at: "2026-10-20T19:00:00Z",
  scores,
  skips: [],
});

Deno.test("score push: shape, range and one decimal", () => {
  assertEquals(
    checkPush(
      push([{
        competition_id: 100,
        competitor_id: 1001,
        judge_id: 7,
        criteria_id: 1,
        score: 7.5,
      }]),
    ),
    [],
  );
  const bad = checkPush(push([
    {
      competition_id: 100,
      competitor_id: 1001,
      judge_id: 7,
      criteria_id: 1,
      score: 7.25,
    },
    {
      competition_id: 100,
      competitor_id: 1001,
      judge_id: 7,
      criteria_id: 2,
      score: 11,
    },
    {
      competition_id: 100,
      competitor_id: 1001,
      judge_id: 7,
      criteria_id: 2,
      score: 5,
    },
  ]));
  assertEquals(bad.length, 3, bad.join("\n"));
  assert(checkPush({ nope: 1 }).length > 0);
  assert(checkPush("text").length > 0);
});

Deno.test("score push: rows must belong to the bundle", () => {
  const errs = checkAgainstBundle(
    push([
      {
        competition_id: 100,
        competitor_id: 1001,
        judge_id: 8,
        criteria_id: 1,
        score: 5,
      },
      {
        competition_id: 100,
        competitor_id: 1001,
        judge_id: 8,
        criteria_id: 2,
        score: 5,
      },
      {
        competition_id: 100,
        competitor_id: 9999,
        judge_id: 7,
        criteria_id: 1,
        score: 5,
      },
    ]),
    DATA,
  );
  assertEquals(errs.length, 2, errs.join("\n"));
  assertStringIncludes(errs[0], "judge 8 does not score criterion 2");
  assertStringIncludes(errs[1], "competitor 9999 is not in competition 100");
});

Deno.test("results: weighted totals, ranked", () => {
  const t = tallyResults(DATA, [
    {
      competition_id: 100,
      competitor_id: 1001,
      judge_id: 7,
      criteria_id: 1,
      score: 6,
    },
    {
      competition_id: 100,
      competitor_id: 1001,
      judge_id: 7,
      criteria_id: 2,
      score: 6,
    },
    {
      competition_id: 100,
      competitor_id: 1002,
      judge_id: 7,
      criteria_id: 1,
      score: 5,
    },
    {
      competition_id: 100,
      competitor_id: 1002,
      judge_id: 7,
      criteria_id: 2,
      score: 8.5,
    },
  ]);
  assertEquals(t.get(100)!.map((r) => [r.competitor_id, r.total]), [
    [1002, 22],
    [1001, 18],
  ]);
});
