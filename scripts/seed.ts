/**
 * A demo festival to click around in: an organiser, a structure with categories,
 * competitors with real partners and normalised music, registration open.
 *
 *   deno task seed                      seed the database in DATABASE_URL
 *   deno task seed --fixture <dir>      also export a dry-run bundle into <dir>
 *                                       (a fixture for the competition server)
 *
 * Accounts (password "demo-password"):
 *   organiser@example.com   the organiser
 *   dana@example.com        female, amateur, 36 (solo, and in a mixed pro-am couple)
 *   sam@example.com         male, professional (Dana's partner)
 *   kim@example.com         female, amateur (in a same-gender couple with Lou)
 *   lou@example.com         female, amateur
 *
 * Refuses to run on a database that already has users.
 */
import { join } from "node:path";
import { acceptUpload } from "../src/audio/audio.ts";
import { drain } from "../src/audio/worker.ts";
import { register, type User } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import type { AppContext } from "../src/context.ts";
import { connect, migrate } from "../src/db.ts";
import { addMember, createCompetitor, enter } from "../src/entries.ts";
import { exportFestival } from "../src/export/exporter.ts";
import { ConsoleMailer } from "../src/mail.ts";
import { updateProfile } from "../src/profile.ts";
import { DiskStorage } from "../src/storage.ts";

const fixtureAt = Deno.args.indexOf("--fixture");
const fixtureDir = fixtureAt >= 0 ? Deno.args[fixtureAt + 1] : undefined;

const config = loadConfig();
const sql = connect(config.databaseUrl, { max: 2 });
await migrate(sql);
const ctx: AppContext = {
  config,
  sql,
  storage: new DiskStorage(config.storageDir),
  mailer: new ConsoleMailer(),
};
await Deno.mkdir(config.exportDir, { recursive: true });

if ((await sql`SELECT 1 FROM users LIMIT 1`).length) {
  console.error("This database already has users; seed a fresh one.");
  await sql.end();
  Deno.exit(1);
}

const password = "demo-password";
const organiser = await register(ctx, {
  email: "organiser@example.com",
  name: "Organiser",
  password,
});
await sql`UPDATE users SET is_admin = true WHERE id = ${organiser.id}`;

const people = {
  dana: {
    email: "dana@example.com",
    name: "Dana Lee",
    gender: "female",
    date_of_birth: "1990-05-01",
    level: "amateur",
  },
  sam: {
    email: "sam@example.com",
    name: "Sam Ortiz",
    gender: "male",
    date_of_birth: "1988-03-12",
    level: "professional",
  },
  kim: {
    email: "kim@example.com",
    name: "Kim Park",
    gender: "female",
    date_of_birth: "1994-07-20",
    level: "amateur",
  },
  lou: {
    email: "lou@example.com",
    name: "Lou Reyes",
    gender: "female",
    date_of_birth: "1993-11-02",
    level: "amateur",
  },
} as const;
const user = {} as Record<keyof typeof people, User>;
for (const key of Object.keys(people) as (keyof typeof people)[]) {
  const p = people[key];
  const u = await register(ctx, { email: p.email, name: p.name, password });
  await updateProfile(ctx, u, {
    gender: p.gender,
    date_of_birth: p.date_of_birth,
    level: p.level,
  });
  user[key] = u;
}
const dana = user.dana;

// Festival: age is worked out on its first day.
const [f] = await sql<{ id: number }[]>`
  INSERT INTO festivals (name, registration_open, freeze_at, age_on)
  VALUES ('Autumn Open', true, now() + interval '14 days', '2026-10-20') RETURNING id`;
const [rubric] = await sql<{ id: number }[]>`
  INSERT INTO rubrics (festival_id, name) VALUES (${f.id}, 'Standard') RETURNING id`;
const criteria = await sql<{ id: number }[]>`
  INSERT INTO criteria (rubric_id, name, weight) VALUES
    (${rubric.id}, 'Technique', 1), (${rubric.id}, 'Musicality', 1), (${rubric.id}, 'Presentation', 1)
  RETURNING id`;
const judges = await sql<{ id: number }[]>`
  INSERT INTO judges (festival_id, name) VALUES (${f.id}, 'Judge Ada'), (${f.id}, 'Judge Ben'), (${f.id}, 'Judge Cy')
  RETURNING id`;
for (const j of judges) {
  for (const c of criteria) {
    await sql`INSERT INTO judge_criteria VALUES (${j.id}, ${c.id})`;
  }
}
const [track] = await sql<{ id: number }[]>`
  INSERT INTO tracks (festival_id, name, location) VALUES (${f.id}, 'Main floor', 'Hall A') RETURNING id`;
const days = (n: number, h: number) => new Date(Date.UTC(2026, 9, 20 + n, h));
const [s1] = await sql<{ id: number }[]>`
  INSERT INTO sessions (track_id, name, start_time, order_number)
  VALUES (${track.id}, 'Afternoon', ${days(0, 14)}, 1) RETURNING id`;
const [s2] = await sql<{ id: number }[]>`
  INSERT INTO sessions (track_id, name, start_time, order_number)
  VALUES (${track.id}, 'Evening', ${days(0, 18)}, 2) RETURNING id`;

// Category rules are the portal's; the names carry them for people to read.
const comps = await sql<{ id: number }[]>`
  INSERT INTO competitions (festival_id, session_id, name, rubric_id, order_number,
      gender, level, min_age, max_age) VALUES
    (${f.id}, ${s1.id}, 'Women · Amateur · Latin solo', ${rubric.id}, 1, 'female', 'amateur', 18, 40),
    (${f.id}, ${s1.id}, 'Mixed couples · Pro-am · Latin couples', ${rubric.id}, 2, 'mixed', 'pro_am', NULL, NULL),
    (${f.id}, ${s2.id}, 'Same-gender couples · Amateur · Latin couples', ${rubric.id}, 1, 'same_gender', 'amateur', 18, 60),
    (${f.id}, ${s2.id}, 'Open · Pro-am · Showcase teams', ${rubric.id}, 2, 'open', 'pro_am', NULL, NULL)
  RETURNING id`;
// Open for entries, but not scheduled in a session yet.
await sql`INSERT INTO competitions (festival_id, name, rubric_id)
  VALUES (${f.id}, 'Open · Hip hop solo', ${rubric.id})`;

async function tone(freq: number, seconds: number): Promise<Uint8Array> {
  const out = await new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:duration=${seconds}`,
      "-af",
      `volume=-${10 + freq % 17}dB`,
      "-f",
      "wav",
      "-",
    ],
    stdout: "piped",
  }).output();
  return out.stdout;
}

/** A competitor for `owner`, with its partners added by email. */
async function competitor(
  name: string,
  type: "individual" | "couple" | "team",
  partners: User[],
): Promise<number> {
  const id = await createCompetitor(ctx, dana, { name, type });
  for (const p of partners) await addMember(ctx, dana, id, p.email);
  return id;
}

// Each competitor enters one competition: [competitor, competition, seconds].
const solo = await competitor("Dana Lee", "individual", []);
const mixed = await competitor("Dana and Sam", "couple", [user.sam]);
const sameGender = await competitor("Kim and Lou", "couple", [user.lou]);
const team = await competitor("The Night Owls", "team", [user.sam, user.kim]);

const entries: [number, number, number][] = [
  [solo, comps[0].id, 95],
  [mixed, comps[1].id, 150],
  [sameGender, comps[2].id, 140],
  [team, comps[3].id, 180],
];
let freq = 220;
for (const [competitorId, competitionId, duration] of entries) {
  const entryId = await enter(ctx, dana, {
    competitorId,
    competitionId,
    duration,
  });
  await acceptUpload(ctx, {
    entryId,
    kind: "music",
    data: await tone(freq += 55, 3),
    name: `${competitorId}.wav`,
    userId: dana.id,
    festivalId: f.id,
  });
}
console.log(`normalised ${await drain(ctx)} file(s)`);

if (fixtureDir) {
  const x = await exportFestival(ctx, f.id, {
    final: false,
    userId: organiser.id,
  });
  await Deno.remove(fixtureDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(fixtureDir, "audio"), { recursive: true });
  for (const name of ["manifest.json", "data.json"]) {
    await Deno.copyFile(join(x.folder, name), join(fixtureDir, name));
  }
  for await (const e of Deno.readDir(join(x.folder, "audio"))) {
    await Deno.copyFile(
      join(x.folder, "audio", e.name),
      join(fixtureDir, "audio", e.name),
    );
  }
  console.log(`fixture bundle (digest ${x.digest}) in ${fixtureDir}`);
}

console.log(
  `Seeded festival ${f.id}. Sign in as organiser@example.com or dana@example.com, password "${password}".`,
);
await sql.end();
