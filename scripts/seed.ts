/**
 * A demo festival to click around in: an organiser, a structure, competitors
 * with normalised music, registration open.
 *
 *   deno task seed                      seed the database in DATABASE_URL
 *   deno task seed --fixture <dir>      also export a dry-run bundle into <dir>
 *                                       (a fixture for the competition server)
 *
 * Accounts: organiser@example.com and dancer@example.com, password
 * "demo-password". Refuses to run on a database that already has users.
 */
import { join } from "node:path";
import { acceptUpload } from "../src/audio/audio.ts";
import { drain } from "../src/audio/worker.ts";
import { register } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import type { AppContext } from "../src/context.ts";
import { connect, migrate } from "../src/db.ts";
import { createCompetitor, enter } from "../src/entries.ts";
import { exportFestival } from "../src/export/exporter.ts";
import { ConsoleMailer } from "../src/mail.ts";
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
const dancer = await register(ctx, {
  email: "dancer@example.com",
  name: "Dancer",
  password,
});

const [f] = await sql<{ id: number }[]>`
  INSERT INTO festivals (name, registration_open, freeze_at)
  VALUES ('Autumn Open', true, now() + interval '14 days') RETURNING id`;
const [rubric] = await sql<
  { id: number }[]
>`INSERT INTO rubrics (festival_id, name) VALUES (${f.id}, 'Standard') RETURNING id`;
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
const comps = await sql<{ id: number }[]>`
  INSERT INTO competitions (festival_id, session_id, name, rubric_id, order_number) VALUES
    (${f.id}, ${s1.id}, 'Latin solo', ${rubric.id}, 1),
    (${f.id}, ${s1.id}, 'Latin couples', ${rubric.id}, 2),
    (${f.id}, ${s2.id}, 'Showcase teams', ${rubric.id}, 1)
  RETURNING id`;
// Open for entries, but not scheduled in a session yet.
await sql`INSERT INTO competitions (festival_id, name, rubric_id)
  VALUES (${f.id}, 'Hip hop solo', ${rubric.id})`;

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

const people: [string, "individual" | "couple" | "team", number[]][] = [
  ["Alex Rivera", "individual", [0]],
  ["Jo Park", "individual", [0]],
  ["Sam and Kim", "couple", [1]],
  ["Lee and Max", "couple", [1]],
  ["The Night Owls", "team", [2]],
];
let freq = 220;
for (const [name, type, enters] of people) {
  const competitorId = await createCompetitor(ctx, dancer, { name, type });
  for (const i of enters) {
    const entryId = await enter(ctx, { ...dancer, is_admin: true }, {
      competitorId,
      competitionId: comps[i].id,
      duration: 90 + freq % 60,
    });
    await acceptUpload(ctx, {
      entryId,
      kind: "music",
      data: await tone(freq += 55, 3),
      name: `${name}.wav`,
      userId: dancer.id,
      festivalId: f.id,
    });
  }
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
  `Seeded festival ${f.id}. Sign in as organiser@example.com or dancer@example.com, password "${password}".`,
);
await sql.end();
