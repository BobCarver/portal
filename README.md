# Registration portal

Competitors register, enter competitions and upload their music before a
festival. Organisers set up the festival, fix problems, freeze registration and
export the **festival bundle** that the competition server (`../sse-app`) runs
from on the day. During and after the event the competition server pushes scores
back. The design is in [portal.md](portal.md).

Stack: Deno, [Hono](https://hono.dev), Postgres, ffmpeg. Pages are rendered on
the server: plain HTML forms with a few lines of script.

## Quick start

```sh
deno task db:start          # private Postgres in ./.pgdata on port 5544 (local binaries, no Docker)
deno task seed              # demo festival; sign in as organiser@example.com / demo-password
deno task dev               # http://localhost:8080
```

Make a real organiser with `deno task admin you@example.com "Your Name"`, which
prints a link to set the password.

Needs `ffmpeg` (with libmp3lame) on the PATH, and Postgres 15+ binaries for
`db:start`. Elsewhere, set `DATABASE_URL` to any Postgres.

## Tasks

| Task | What it does |
|---|---|
| `deno task dev` / `start` | Web app, with the normalisation worker inside it. Migrations run at start |
| `deno task worker` | The worker as its own process (start the web app with `WORKER=separate`) |
| `deno task migrate` | Apply `db/*.sql` |
| `deno task admin <email>` | Create an organiser, or promote an account |
| `deno task seed [--fixture dir]` | Demo data. `--fixture` also writes a dry-run bundle there |
| `deno task test` | Unit tests, then integration tests (real Postgres and ffmpeg) |
| `deno task static` | Type check, lint, format check |

Integration tests use `TEST_DATABASE_URL`, by default `portal_test` on port 5544.
The schema is dropped and recreated for each run. Without a database they are
skipped with a warning.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres@localhost:5544/portal` | |
| `PORT`, `BASE_URL` | `8080`, `http://localhost:8080` | `BASE_URL` goes into emailed links; `https:` turns on secure cookies |
| `STORAGE_DIR`, `EXPORT_DIR` | `data/storage`, `data/exports` | Originals and normalised audio; written bundles |
| `MAX_UPLOAD_MB` | `50` | |
| `MUSIC_TARGET_LUFS` | `-15` | Recorded in each manifest |
| `ANNOUNCE_TARGET_LUFS` | `-20` | Quieter than music on purpose: a voice at music loudness sounds like shouting |
| `TRUE_PEAK_DB`, `LOUDNESS_RANGE` | `-1`, `11` | |
| `AUDIO_BITRATE`, `AUDIO_SAMPLE_RATE` | `192k`, `44100` | Every normalised file is mp3 at these settings |
| `WORKER` | `inline` | `separate` when `deno task worker` runs on its own |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy (rate limits use `X-Forwarded-For`) |
| `MAX_SCORE_BODY_MB` | `10` | |

## How it fits the plan

| portal.md | Where |
|---|---|
| Accounts: password, magic link, reset (section 2) | `src/auth.ts`, `src/routes/auth.ts`. Only hashes are stored: PBKDF2 for passwords, sha256 for cookies and links. Magic links open a page with a button, so mail scanners do not use them up |
| Competitors, members, entries, withdrawal (section 3) | `src/entries.ts`, `src/routes/competitor.ts` |
| Admin CRUD, strict running order (section 3) | `src/routes/admin.ts`, `src/order.ts`. The uniqueness constraints are deferred, so a whole level is renumbered 1..n inside one transaction. Sessions are always numbered by planned start, so `order_number` and `start_time` never disagree. A competition can be created without a track or session (competitors can enter it already). Choosing a session puts it last in that session's order, and the export is refused while any competition with entries has no session |
| Categories: gender, age, amateur/professional (section 2a) | `src/eligibility.ts` (the rules, pure), `src/categories.ts` (database side), `src/profile.ts`. A person's profile and a competition's rules decide who may enter. Checked on entering, on member, profile and rule changes, and again at export. Never written into a bundle |
| Planning: stages, sessions, running order (section 2b) | `src/plan/planner.ts` (pure, deterministic), `src/plan/db.ts`, `src/routes/plan.ts` (the **Plan** tab). Lengths come from the music, measured once at normalisation. Nobody performs on two stages less than a gap apart; the running order is changed only where that is needed |
| Freeze and final export (section 8) | `src/festival.ts`. Competitors can enter while registration is open, and can upload, replace or withdraw until the freeze. Organisers can change things until the **final** export, then nothing changes. There can be any number of dry-run exports |
| Upload sniffing, size limit, one file per kind (section 6) | `src/audio/sniff.ts`, `src/audio/audio.ts` |
| Two-pass loudnorm, statuses, outlier flags (section 6) | `src/audio/loudnorm.ts`, `src/audio/worker.ts`. The queue is a table read with `FOR UPDATE SKIP LOCKED`; failed jobs are retried, files ffmpeg cannot decode fail at once. Originals are kept |
| Exporter (sections 5 and 7) | `src/export/exporter.ts`. Reads one `REPEATABLE READ` snapshot, builds the tree field by field (this is the privacy boundary), validates, writes canonical JSON, the manifest, the folder and a stored (uncompressed) zip with zip64 support. Records the exact `data.json` text |
| Problems surfaced loudly | Admin entries and export pages. A final export with problems needs an explicit confirmation |
| Score receiver (section 9) | `src/scores.ts`, `POST /api/scores`. Accepts the competition server's `CloudPayload` as is |
| HTTPS bundle pull (section 8 B) | `GET /api/bundle`, `/api/bundle/:id/{manifest.json,data.json,audio/<hash>.mp3,bundle.zip}`, with Range support |
| Shared bundle module (section 7) | Imported from `../sse-app/shared/festival-bundle/` through the `festival-bundle` entry in `deno.json`, so the format is defined in one place |

### The venue's side

On an organiser's festival page, **Generate token** shows a token once. On
the competition server:

```sh
CLOUD_URL=https://portal.example.org/api/scores CLOUD_TOKEN=<token>
```

The same token authenticates the bundle download.

### Choices made for the open questions (portal.md section 12)

- **Loudness**: music at -15 LUFS, announcements at -20 LUFS, true peak -1 dBTP,
  mp3 192 kbps at 44.1 kHz. All of these can be configured. A file is flagged
  when it needed more than 1 dB of limiting, ended more than 1 LU from the
  target, or was silent.
- **Auth**: both password and magic link. Judges have no accounts.
- **Email**: `ConsoleMailer` prints messages to the log. Plug a real `Mailer`
  into `src/main.ts` before opening registration to the public.
- **Results**: the results page ranks by the sum of score × criterion weight
  over all judges. Check that this matches how the competition server ranks.
- **Payments**: not built.
- **Single instance**: the rate limits are in memory.

## Layout

```
db/                  schema migrations (plain SQL, applied in name order)
src/
  app.ts             Hono app, middleware (CSRF origin check, sessions, errors)
  routes/            auth, competitor, admin, api (venue)
  audio/             sniffing, loudnorm, upload, worker
  export/            exporter, zip writer
  views/             html template tag, layout
fixtures/bundles/demo  a bundle exported from the seed data; passes the shared validator
tests/unit           no database needed
tests/integration    the whole flow over HTTP with real Postgres and ffmpeg
```
