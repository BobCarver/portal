import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  canonicalData,
  type FestivalData,
  makeManifest,
  validateData,
} from "festival-bundle";
import { buildBundle, type Snapshot } from "../../src/export/exporter.ts";

const SHA = (c: string) => c.repeat(64);

/** Two rubrics (one unused), two judges (one unassigned), three competitions (one empty). */
function snapshot(): Snapshot {
  const ready = (entry_id: number, sha: string) => ({
    entry_id,
    kind: "music" as const,
    status: "ready" as const,
    reason: null,
    sha256: sha,
    bytes: 1000 + entry_id,
    content_type: "audio/mpeg",
    storage_key: `normalised/${sha}.mp3`,
    lufs: -15,
    true_peak_db: -1.2,
  });
  return {
    festival: { id: 1, name: "Autumn Open" },
    tracks: [{ id: 1, name: "Main floor", location: "Hall A" }],
    sessions: [{
      id: 10,
      track_id: 1,
      name: "Session 1",
      start_time: new Date("2026-10-20T18:00:00Z"),
      order_number: 1,
    }],
    competitions: [
      {
        id: 100,
        session_id: 10,
        name: "Latin solo",
        order_number: 1,
        rubric_id: 1,
      },
      {
        id: 101,
        session_id: 10,
        name: "Latin couples",
        order_number: 2,
        rubric_id: 1,
      },
      { id: 102, session_id: 10, name: "Empty", order_number: 3, rubric_id: 2 },
    ],
    rubrics: [{ id: 1, name: "Standard" }, { id: 2, name: "Unused" }],
    criteria: [
      { id: 1, rubric_id: 1, name: "Technique", weight: 1 },
      { id: 2, rubric_id: 1, name: "Musicality", weight: 2 },
      { id: 3, rubric_id: 2, name: "Show", weight: 1 },
    ],
    judges: [{ id: 7, name: "Judge Ada" }, { id: 8, name: "Judge Unassigned" }],
    judgeCriteria: [{ judge_id: 7, criterion_id: 1 }, {
      judge_id: 7,
      criterion_id: 2,
    }],
    entries: [
      {
        id: 1,
        competition_id: 100,
        competitor_id: 1001,
        order_number: 1,
        duration: 95,
        competitor_name: "Alex Rivera",
        competitor_type: "individual",
      },
      {
        id: 2,
        competition_id: 101,
        competitor_id: 1002,
        order_number: 1,
        duration: 120,
        competitor_name: "Sam and Kim",
        competitor_type: "couple",
      },
      // The same competitor in a second competition, same song: stored once.
      {
        id: 3,
        competition_id: 101,
        competitor_id: 1001,
        order_number: 2,
        duration: 95,
        competitor_name: "Alex Rivera",
        competitor_type: "individual",
      },
    ],
    audio: [ready(1, SHA("a")), ready(2, SHA("b")), ready(3, SHA("a"))],
  };
}

async function digestOf(s: Snapshot) {
  const b = buildBundle(s);
  const text = canonicalData(b.data);
  return {
    built: b,
    text,
    manifest: await makeManifest({
      dataText: text,
      generatedAt: "2026-10-01T00:00:00Z",
    }),
  };
}

Deno.test("export: the tree mirrors the competition server's and validates", () => {
  const { data, errors, problems } = buildBundle(snapshot());
  assertEquals(errors, []);
  assertEquals(problems, []);
  assertEquals(validateData(data), []);
  const comps = data.festival.tracks[0].sessions[0].competitions;
  assertEquals(
    comps.map((c) => c.id),
    [100, 101],
    "a competition with no entries is left out",
  );
  assertEquals(comps[1].competitors.map((p) => p.id), [1002, 1001]);
  assertEquals(comps[0].competitors[0].audio.music?.sha256, SHA("a"));
  assertEquals(
    data.festival.tracks[0].sessions[0].start_time,
    "2026-10-20T18:00:00Z",
  );
});

Deno.test("export: each used rubric once; unused rubrics and unassigned judges left out", () => {
  const { data } = buildBundle(snapshot());
  assertEquals(data.festival.rubrics.map((r) => r.id), [1]);
  assertEquals(data.festival.rubrics[0].judges, [{
    id: 7,
    name: "Judge Ada",
    criteria: [1, 2],
  }]);
  assertEquals(data.festival.rubrics[0].criteria.map((c) => c.weight), [1, 2]);
});

Deno.test("export: same data gives the same bytes and digest", async () => {
  const a = await digestOf(snapshot());
  // Same data, rows in a different order (as a database may return them).
  const s = snapshot();
  s.entries.reverse();
  s.competitions.reverse();
  s.audio.reverse();
  s.judgeCriteria.reverse();
  const b = await digestOf(s);
  assertEquals(a.text, b.text);
  assertEquals(a.manifest.digest, b.manifest.digest);
});

Deno.test("export: any exported field changed gives a different digest", async () => {
  const base = (await digestOf(snapshot())).manifest.digest;
  const changes: ((s: Snapshot) => void)[] = [
    (s) => (s.festival.name = "Spring Open"),
    (s) => (s.tracks[0].location = "Hall B"),
    (s) => (s.sessions[0].start_time = new Date("2026-10-20T18:30:00Z")),
    (s) => (s.competitions[0].name = "Latin solo (open)"),
    (s) => (s.entries[0].duration = 96),
    (s) => (s.entries[0].competitor_name = "Alex R."),
    (s) => (s.criteria[1].weight = 3),
    (s) => (s.judges[0].name = "Judge Bea"),
    (s) => (s.audio[1].sha256 = SHA("c")),
    (s) => {
      s.entries[1].order_number = 2;
      s.entries[2].order_number = 1;
    },
  ];
  for (const [i, change] of changes.entries()) {
    const s = snapshot();
    change(s);
    assertNotEquals((await digestOf(s)).manifest.digest, base, `change ${i}`);
  }
});

Deno.test("export: only the bundle's fields cross (privacy boundary)", () => {
  const s = snapshot() as Snapshot & Record<string, unknown>;
  // Extra, private columns a careless query might have read.
  const leaky = s as unknown as {
    entries: Record<string, unknown>[];
    judges: Record<string, unknown>[];
    festival: Record<string, unknown>;
  };
  leaky.entries[0].members = ["alex@example.com"];
  leaky.entries[0].email = "alex@example.com";
  leaky.judges[0].email = "ada@example.com";
  leaky.festival.api_token_hash = "secret";
  const text = canonicalData(buildBundle(s).data);
  for (
    const word of [
      "@example.com",
      "members",
      "email",
      "secret",
      "password",
      "storage_key",
      "lufs",
    ]
  ) {
    assert(!text.includes(word), `data.json mentions ${word}`);
  }
  const allowed = new Set([
    "festival",
    "id",
    "name",
    "rubrics",
    "tracks",
    "criteria",
    "weight",
    "judges",
    "location",
    "sessions",
    "start_time",
    "order_number",
    "competitions",
    "rubric_id",
    "competitors",
    "type",
    "duration",
    "audio",
    "music",
    "announce",
    "sha256",
    "content_type",
    "bytes",
  ]);
  const keys = new Set<string>();
  JSON.parse(text, (k, v) => (k && keys.add(k), v));
  for (const k of keys) {
    assert(allowed.has(k) || /^\d+$/.test(k), `unexpected key ${k}`);
  }
});

Deno.test("export: audio not ready goes to problems, not into data", () => {
  const s = snapshot();
  s.audio[1] = {
    ...s.audio[1],
    status: "processing",
    sha256: null,
    bytes: null,
    storage_key: null,
  };
  s.audio.splice(2, 1); // entry 3 has no music at all
  s.audio.push({
    ...s.audio[0],
    entry_id: 1,
    kind: "announce",
    status: "failed",
    reason: "could not decode the audio",
    sha256: null,
  });
  const { data, problems, errors } = buildBundle(s);
  assertEquals(errors, []);
  assertEquals(problems, [
    {
      competition_id: 100,
      competitor_id: 1001,
      kind: "announce",
      reason: "failed: could not decode the audio",
    },
    {
      competition_id: 101,
      competitor_id: 1001,
      kind: "music",
      reason: "missing",
    },
    {
      competition_id: 101,
      competitor_id: 1002,
      kind: "music",
      reason: "processing",
    },
  ]);
  const couples = data.festival.tracks[0].sessions[0].competitions[1];
  assertEquals(couples.competitors.map((p) => p.audio), [{}, {}]);
});

Deno.test("export: duplicate order_number is refused with a readable error", () => {
  const s = snapshot();
  s.entries[2].order_number = 1;
  const { errors } = buildBundle(s);
  assert(
    errors.some((e) => e.includes("order_number 1 is used twice")),
    errors.join("\n"),
  );
});

Deno.test("export: a competition whose rubric is not in the festival is refused", () => {
  const s = snapshot();
  s.competitions[0].rubric_id = 99; // a rubric of another festival
  const { errors } = buildBundle(s);
  assert(
    errors.some((e) =>
      e.includes("rubric_id 99 is not one of the festival's rubrics")
    ),
    errors.join("\n"),
  );
});

Deno.test("export: a used rubric with no judge is refused", () => {
  const s = snapshot();
  s.judgeCriteria = [];
  const { errors } = buildBundle(s);
  assert(
    errors.some((e) => e.includes("needs at least one judge")),
    errors.join("\n"),
  );
});

Deno.test("validation: judge criteria must belong to their rubric", () => {
  const { data } = buildBundle(snapshot());
  const bad = structuredClone(data) as FestivalData;
  bad.festival.rubrics[0].judges[0].criteria.push(3);
  assert(
    validateData(bad).some((e) =>
      e.includes("criterion 3, which is not in the rubric")
    ),
  );
});

Deno.test("export: a competition with entries but no session is refused", () => {
  const s = snapshot();
  s.competitions[0].session_id = null;
  s.competitions[0].order_number = null;
  const { errors, data } = buildBundle(s);
  assert(
    errors.some((e) =>
      e.includes(
        "competition 100 (Latin solo) has 1 entry but no track and session",
      )
    ),
    errors.join("\n"),
  );
  assertEquals(
    data.festival.tracks[0].sessions[0].competitions.map((c) => c.id),
    [101],
  );
});

Deno.test("export: an unscheduled competition without entries is simply left out", () => {
  const s = snapshot();
  s.competitions.push({
    id: 103,
    session_id: null,
    name: "Hip hop solo",
    order_number: null,
    rubric_id: 1,
  });
  const { errors, data } = buildBundle(s);
  assertEquals(errors, []);
  assert(!canonicalData(data).includes("Hip hop"));
});
