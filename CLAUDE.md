# CLAUDE.md

Registration portal for a dance competition. Competitors register, enter
competitions and upload music before the festival. Organisers set up the festival,
freeze registration and export a **festival bundle** that the competition server
(`../sse-app`) runs from on the day. Scores come back from the venue by push.
Design: [portal.md](portal.md) (the spec). Remaining work: [plan.md](plan.md).

Stack: Deno, Hono, Postgres (`npm:postgres`), ffmpeg. Pages are rendered on the
server as plain HTML forms with a few lines of script. No client framework.

**Sibling repo required.** `deno.json` maps `festival-bundle` to
`../sse-app/shared/festival-bundle/mod.ts`. Clone `sse-app` next to this repo or
nothing runs. That module is the contract with the competition server: the
bundle format (portal -> venue) and the score push (venue -> portal). Change it in
`sse-app` first, then here.

## Commands

```sh
deno task db:start          # private Postgres on localhost:5544, data in .pgdata (no Docker)
deno task db:stop
deno task migrate           # apply db/*.sql (the server also does this at start)
deno task seed [--fixture dir]   # demo festival; --fixture also writes a dry-run bundle
deno task admin <email> [name]   # make an account an organiser (prints a reset link if new)
deno task dev               # server on :8080 with restart on change (worker runs inside it)
deno task start             # same, without watching
deno task worker            # normalisation worker alone (with WORKER=separate on the server)
deno task static            # type check + lint + fmt check
deno task test              # unit, then integration; stops on the first failure
deno task test:unit | test:integration
deno task fmt
```

Demo login after `deno task seed`: `organiser@example.com` / `demo-password`
(organiser) or `dancer@example.com` (competitor). Demo only; never seed a real
database.

Check exit codes, not only "N passed". Integration tests skip with a warning, and
exit 0, when no database is reachable: run `deno task db:start` first.

## Environment

Read once in `src/config.ts`. Main settings: `DATABASE_URL` (default
`postgres://postgres@localhost:5544/portal`), `PORT` (8080), `BASE_URL` (used in
emailed links; `https:` turns on secure cookies), `STORAGE_DIR` (`data/storage`),
`EXPORT_DIR` (`data/exports`), `MAX_UPLOAD_MB` (50), `MUSIC_TARGET_LUFS` (-15),
`ANNOUNCE_TARGET_LUFS` (-20), `TRUE_PEAK_DB` (-1), `LOUDNESS_RANGE` (11),
`AUDIO_BITRATE` (192k), `AUDIO_SAMPLE_RATE` (44100), `WORKER` (`inline` or
`separate`), `TRUST_PROXY` (`1` behind a proxy), `MAX_SCORE_BODY_MB` (10).
Tests: `TEST_DATABASE_URL` (default `postgres://postgres@localhost:5544/portal_test`).

ffmpeg with libmp3lame must be on the PATH. Tests run it for real, and use `unzip`.

## Layout

```
db/                  migrations, plain SQL, run in name order (001_init, 002_unscheduled_competitions, 003_categories)
src/
  main.ts            web process: migrate, inline worker, Deno.serve
  worker.ts          worker process (WORKER=separate)
  app.ts             Hono app: CSRF origin check, session cookie, error handling, page()/back()
  config.ts          all settings
  db.ts              connect, migrate, logEvent
  auth.ts            accounts, sessions, one-time links, rate limiter
  entries.ts         competitors, members, entering, withdrawing, duration
  eligibility.ts     the category rules as pure functions (gender, age band, level): no database
  categories.ts      the database side of those rules: load members and a competition, re-check entries
  profile.ts         a person's gender, date of birth and level; changing them re-checks their entries
  festival.ts        festivalState: what may change now (freeze, final export)
  order.ts           running order: nextOrder, renumber, moveTo/moveBy, closeGaps
  scores.ts          score receiver (uses the shared push checks) and results tally
  audio/             sniff.ts (format from bytes), loudnorm.ts (ffmpeg), audio.ts (upload), worker.ts (queue)
  export/            exporter.ts (snapshot -> tree -> bundle), zip.ts (stored zip, zip64)
  routes/            auth, competitor, admin, api (venue token)
  views/             html.ts (escaping template tag), layout.ts (page shell, helpers)
  storage.ts         Storage interface + disk; keys like originals/<sha>.mp3
  mail.ts            Mailer interface; ConsoleMailer prints to the log
scripts/             dev-db.sh, migrate, create-admin, seed
fixtures/bundles/demo  bundle exported from the seed; passes the shared validator
tests/unit           no database needed
tests/integration    whole flow over HTTP with real Postgres and ffmpeg
```

## How it works

- **Two databases, never shared.** This database holds everything before the
  event. The competition server has its own (scores, cursor, skips, device links)
  and never connects here. Only the bundle and the score push cross between them.
- **Ownership.** The portal owns the festival structure and everything about
  people. The bundle carries only the fields in portal.md section 4.
- **Privacy boundary.** The exporter copies fields one by one into the bundle
  tree (`buildBundle` in `src/export/exporter.ts`). Never pass a row through
  whole. No emails, password hashes, member lists or payment data may reach a
  bundle. `tests/unit/exporter.test.ts` checks this.
- **Bundle is final.** `exports.data_text` keeps the exact text of `data.json`
  for each export. Digest and identity come from the shared `bundleDigest`. A
  final export locks the festival: `festivalState` and `assertAdminCanEdit` refuse
  every later edit. Dry runs can be repeated.
- **Freeze** (`festivals.freeze_at`) closes competitor edits: entering, uploads,
  duration, withdrawing. Organisers may still edit until the final export.
- **Running order.** Every session, competition and entry has an `order_number`
  that is 1..n with no gaps among its siblings. Changes renumber the whole level
  in one transaction (`renumber`). Unique constraints are deferred for that.
  Sessions are ordered by planned `start_time`, then `order_number`.
- **Competitions** belong to the festival (`festival_id`). They have a session and
  order number only once scheduled. Exporting a competition that has entries but
  no session is refused.
- **Audio** is accepted by its first bytes, never by name or content type. Each
  upload is queued in `audio_jobs`; the worker claims jobs with `FOR UPDATE SKIP
  LOCKED`. Originals are kept under `originals/`. Normalised files are
  content-addressed under `normalised/<sha256>.mp3`. A bad file fails at once; a
  temporary error is retried.
- **Scores** arrive as a full snapshot per push. The receiver replaces the
  festival's scores in one transaction. It refuses a push whose `bundle_digest`
  is not an export of this festival, and ignores a push older than the last one
  applied. Rows that do not belong to the bundle are refused with 422, by the
  shared `checkScoresAgainstBundle`.
- **Categories** (portal.md section 2a). `eligibility()` decides whether a competitor
  may enter a competition, and returns readable reasons. It runs when entering, when
  members or profiles change, when a competition's rules or the festival's age date
  change, and in the exporter. Those writes run in a transaction that re-checks the
  affected entries, so a refused change is rolled back. The categories never reach a
  bundle: the competition server does not need them.
- **Auth.** Routes call `needUser` / `needAdmin`. Competitor data goes through
  `assertMember`. Forms are protected by the Origin check (Hono `csrf`). The venue
  API (`/api/*`) has no cookies: it uses a per-festival bearer token, stored only as
  a hash.
- **Errors.** Throw `UserError(message, status)` for anything the user can fix.
  Form errors redirect back with `?err=`; API errors return JSON.

## Decisions (and why)

- **Hono, not a framework with a client bundle.** The pages are forms. The venue
  API is JSON. Nothing needs client-side state.
- **Own Postgres schema per system.** Sharing one schema would couple the portal to
  the venue server for no gain. Sharing the contract (bundle format, score push)
  is the part that must stay identical, so that lives in the shared module.
- **Migrations are append-only.** Add `db/NNN_*.sql`. Never edit one that has run,
  because the runner skips it.
- **Plain HTML template, not JSX.** `html` escapes every interpolation; `raw()` is
  the only way to insert markup, and only for trusted strings.
- **Table-backed job queue.** No Redis. Several workers would be safe with the
  current `SKIP LOCKED` claim.
- **Rate limits are in memory.** Fine for one instance; see plan.md before scaling.
- **Magic links open a page with a button.** Mail scanners that fetch links would
  otherwise use them up.
- **Config from the environment.** `src/config.ts` is the only code in `src` and
  `scripts` that reads `Deno.env`.

## Gotchas

- **`deno fmt` reflows the inside of `html` templates.** That changed the escaping
  test's input once. Use `// deno-fmt-ignore` on a line where the exact text
  matters. `deno task static` runs the format check, so a reformat can fail it.
- **`testContext` drops the `public` schema** of `TEST_DATABASE_URL`. The default
  is `portal_test`. Never point it at a database with data.
- **`DATABASE_URL` defaults to the dev database** (`portal`, port 5544), so the
  server and seed use it, and tests use `portal_test`. A bare `deno task dev` on a
  database that has no migrations applied is migrated at start.
- **Schema changes need a new file.** Changing `001_init.sql` does nothing for a
  database that already ran it. Apply the new file with `deno task migrate`, or just
  start the server.
- **Dates come back as `Date` objects** from postgres.js, which shifts them by a day
  in some time zones. Select `::text` or `to_char(..., 'YYYY-MM-DD')` for any `DATE`
  column (`date_of_birth`, `age_on`).
- **A couple has exactly two members, a soloist one.** `addMember` refuses a third member
  for a couple and a second for a soloist. Entries are checked the same way.
- **Edit the admin pages through `editable(fid)`** so the final-export lock holds.
  Every new admin POST that changes data should call it.
- **Worker ordering.** `order.ts` renumbers the whole level. Call it inside the
  same transaction as the change, or the numbers can go briefly wrong.
- **macOS:** `sed -i ''`. `dev-db.sh` sets `LC_ALL=C`, because Postgres refuses to
  start with a missing locale.
- **The shared module is a relative path.** Moving `sse-app` breaks every import
  here. Publishing it is in plan.md, under "Publish the shared module".
- **Email is only printed** (`ConsoleMailer`). A password reset works only by
  reading the server log, until a real `Mailer` is wired in `src/main.ts`.

## Repo conventions

- Commit only when asked. Commit messages end with a `Co-Authored-By` line.
- Keep route handlers thin: parse input, call a function in `entries.ts`,
  `auth.ts`, `scores.ts` or `export/`, then redirect or render.
- New behaviour gets a unit test if it needs no database, otherwise an
  integration test in `tests/integration/`.
- Keep the format of error messages the same: a sentence a competitor or
  organiser can act on, not a stack trace.

## Status

First implementation of portal.md is committed (`4b3799f`), with the shared score
push (`0c97dc6`). The features in portal.md sections 3 to 9 are built and covered by
the integration test. Not built yet: real email, hosting, an accounts page, CI, and
the venue's side of the HTTPS bundle pull.
The full list, sized and grouped, is in [plan.md](plan.md).
