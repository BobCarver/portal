import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FestivalData } from "festival-bundle";
import { crc32, writeStoredZip } from "../../src/export/zip.ts";
import { tallyResults } from "../../src/scores.ts";

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
