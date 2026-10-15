# Registration portal: design spec

Self-contained brief for building the portal as its own project. It was written
inside the dance-competition scoring app (`sse-app`, "the competition server"). You
should not need that repo's CLAUDE.md. Everything the portal must know about it is
in "The festival bundle" and "Scores from the venue" below. The competition-server
side of the same plan is in `sse-app/redesign.md`.

## 1. Purpose and phases

Competitors register for competitions and upload their music before a festival.
On the day, a separate competition server runs the scoring, from a frozen copy of
the festival made by the portal.

| Phase | Where it runs | What happens |
|-------|---------------|--------------|
| Before the event | Portal, possibly in the cloud | Registration, music upload, loudness normalisation, admin set-up of the festival structure |
| Freeze and hand-over | Between the two | Registration closes; the portal exports a **festival bundle**; the venue copies and verifies it |
| Event day | Competition server, **local at the venue** | Scoring, from the bundle. No dependency on the portal or the internet |
| During and after | Venue -> portal | The competition server pushes scores to the portal (best effort during, authoritative at the end) |

Design rules that follow from this:

1. **The portal is standalone.** It must work when no competition server exists yet.
2. **Data moves one way per direction.** Structure and audio: portal -> venue.
   Scores: venue -> portal. Nothing is edited on both sides, so there is no conflict
   resolution.
3. **The bundle is final.** There are no late changes after the freeze: the
   competition server runs from the bundle as a static, read-only file.
4. **The event never waits on the cloud.** Everything the competition server needs
   is in the bundle.

## 2. Users and roles

- **Competitor** (individual, couple or team): registers, manages their entries,
  uploads and previews music, sees processing status.
- **Admin / organiser**: creates the festival, tracks, sessions, competitions and
  rubrics; assigns judges; sets the running order; freezes registration; exports
  the bundle; sees the scores coming back.
- **Judge**: exists as a person only so the organiser can assign them to rubrics.
  Judges do not use the portal for scoring (scoring is on the competition server).

Authentication is the portal's own (email + password or magic link, with password
reset). It is unrelated to the competition server's admin-issued device links.

## 2a. Categories and eligibility

Every competition takes a category. The portal checks each entry against it; the
competition server does not need the categories, so nothing about them is in the
festival bundle.

- **Person** (a user account): `gender` (male or female), `date_of_birth`, and
  `level` (amateur or professional). A person cannot enter until all three are set.
  They are private: only the person and the organisers see them, and they are never
  exported.
- **Competition**: `gender` (`male`, `female`, `mixed`, `same_gender` or `open`),
  `level` (`amateur`, `professional`, `pro_am` or `open`), and an optional age band
  (`min_age`, `max_age`, both inclusive). The festival's `age_on` date is the day
  ages are worked out on; a band needs it.
- **Competitor category** follows its members. A soloist is male or female. A couple
  is `same_gender` if both partners share a gender, otherwise `mixed`. A team is
  `male` or `female` if every member is, otherwise `mixed`.
- **Entry rules:** the category must match the competition's gender (or the
  competition is `open`); `mixed` and `same_gender` are for couples only. Every
  member must be within the age band on `age_on`. An amateur or professional
  competition takes only members of that level. A `pro_am` competition needs at
  least one professional and one amateur. A couple has exactly two members; a
  soloist has one.
- **Names are for people.** Competition names may say "Women · Amateur · …"; the
  rules are the fields above, and they are what is checked.

The rules are checked whenever they could change the answer: when entering, when
members are added or removed, when a person's profile changes, when a competition's
rules or the festival's age date change, and again at export. A change that would
break an entry is refused, and nothing is saved.

## 3. Functional requirements

### Competitor
- Register an account; create a competitor (type `individual` | `couple` | `team`,
  with member accounts).
- Enter a competition: choose from competitions that are open; a competitor can only
  enter a competition once; set the performance duration (stored in **seconds**).
- Upload **music** and, optionally, an **announcement** per entry (`kind` =
  `music` | `announce`). Replace freely until the freeze. See section 6.
- See the status of each file (`processing`, `ready`, `failed` with a reason), play
  back the normalised result, and see the entry's running position once published.
- Withdraw an entry until the freeze.

### Admin
- CRUD festival, tracks, sessions (with a planned `start_time`), competitions
  (with `order_number`, rubric), rubrics (criteria, judges, per-judge criteria).
- Set a **strict running order**: every session, competition and entry has an
  `order_number` (required, never null), unique among sessions on a track,
  competitions in a session, and entries in a competition. A new row gets the next
  number by default (sessions by `start_time`, competitions by creation, entries by
  registration time); the admin can reorder, and the portal renumbers so there are
  no gaps or duplicates.
- Open and close registration; set the freeze time (section 8).
- Review entries and audio problems; fix or reject.
- Export the festival bundle (section 5); list past exports with their digest.
- See the scores pushed from the venue (section 9) and the time of the last push.

### Out of scope
Scoring, live display, DJ/judge/scoreboard clients, device links, running the
sessions. Payments and ticketing are not specified here (open question in
section 12).

## 4. Data ownership

The portal owns the festival structure and everything about people. The bundle
carries only what the competition server needs to run the day, nested the way the
server walks it (festival > tracks > sessions > competitions > competitors):

| Bundle level | Fields |
|---|---|
| `festival` | `id, name, rubrics, tracks` |
| `rubrics[]` | `id, name, criteria: [{id, name, weight}], judges: [{id, name, criteria: [criteria ids]}]` (every rubric used by an exported competition, once) |
| `tracks[]` | `id, name, location, sessions` |
| `sessions[]` | `id, name, start_time` (planned, UTC), `order_number`, `competitions` |
| `competitions[]` | `id, name, order_number, rubric_id` (must match an entry in `rubrics`), `competitors` |
| `competitors[]` | `id, name, type, order_number, duration` (seconds), `audio` (`music` and optional `announce`: `sha256, content_type, bytes`) |

Only judges assigned to a rubric are exported (they exist as people only to be
assigned); a judge in no rubric is left out. Competitions with no entries are left
out too, as today. Criteria are exported inside each rubric, not as a shared list.

Ids are assigned by the portal and used unchanged by the competition server, so
scores coming back join directly to the portal's own rows.

**Privacy boundary:** the bundle never contains emails, password hashes, member
lists or payment data. Competitors cross as a display `name` and a `type` only;
judges as a display `name`.

**Not in the bundle:** statuses of any kind. Progress (which session is open, who
has performed, actual times) exists only on the competition server.

Time: all timestamps are `TIMESTAMPTZ` in the portal and UTC ISO strings in the
bundle. A session's `start_time` is the **planned** time; the competition server
starts it at that time or, if the previous session on the track overruns, when that
one ends.

## 5. The festival bundle (the contract)

A folder (distributed as-is, or as a zip **stored without compression**; mp3 does
not compress):

```
festival-<id>-<generated_at>/
  manifest.json        what this bundle is and how to verify it
  data.json            the structure, as a nested tree (section 4)
  audio/
    <sha256>.mp3       one file per distinct hash, normalised (section 6)
```

`manifest.json`:

```json
{
  "bundle_version": 1,
  "festival_id": 1,
  "generated_at": "2026-10-20T18:00:00Z",
  "data_sha256": "<sha256 of data.json>",
  "digest": "<sha256 over data_sha256 and the sorted audio hashes>",
  "loudness_target_lufs": -15,
  "audio": [
    { "sha256": "...", "bytes": 4123456, "content_type": "audio/mpeg",
      "lufs": -15.0, "true_peak_db": -1.4 }
  ],
  "problems": [
    { "competition_id": 1000, "competitor_id": 1003, "kind": "music",
      "reason": "processing" }
  ]
}
```

`data.json` is a **nested tree** that mirrors the competition server's in-memory
structure: each competition holds its competitors in running order, and each
competitor holds its own audio. The rubrics are listed once under the festival, and a
competition refers to its rubric by `rubric_id`.

```json
{
  "festival": {
    "id": 1, "name": "Autumn Open",
    "rubrics": [
      {
        "id": 1, "name": "Standard",
        "criteria": [{ "id": 1, "name": "Technique", "weight": 1 },
                     { "id": 2, "name": "Musicality", "weight": 1 }],
        "judges": [{ "id": 1001, "name": "Judge Ada", "criteria": [1, 2] }]
      }
    ],
    "tracks": [
      {
        "id": 1, "name": "Main floor", "location": "Hall A",
        "sessions": [
          {
            "id": 1000, "name": "Session 1", "start_time": "2026-10-20T18:00:00Z",
            "order_number": 1,
            "competitions": [
              {
                "id": 1000, "name": "Latin solo", "order_number": 1, "rubric_id": 1,
                "competitors": [
                  { "id": 1001, "name": "Alex Rivera", "type": "individual",
                    "order_number": 1, "duration": 15,
                    "audio": { "music": { "sha256": "...", "content_type": "audio/mpeg",
                                          "bytes": 4123456 } } }
                ]
              },
              {
                "id": 1001, "name": "Latin couples", "order_number": 2, "rubric_id": 1,
                "competitors": [
                  { "id": 1002, "name": "Sam and Kim", "type": "couple",
                    "order_number": 1, "duration": 20,
                    "audio": { "music": { "sha256": "...", "content_type": "audio/mpeg",
                                          "bytes": 3987654 } } }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

**Rubrics.** Each rubric is written once, under `festival.rubrics`, with a unique
`id`. Every competition's `rubric_id` must match one of them. Nothing is inherited
from another competition: each competition names its rubric.

Other rules:

Rules:

- **Content-addressed audio.** File name = `<sha256>.<ext>`. A file that is present
  can only be the right content; a replaced song is a new hash and a new name; the
  same song in two competitions is stored once.
- **Incremental copying.** The receiver copies only hashes it does not hold. A
  **data-only bundle** (`manifest.json` + `data.json`, no `audio/`) is valid when
  the venue already holds every listed hash.
- **Only `ready` normalised files are exported.** Anything `failed` or still
  `processing` goes in `problems`, and the export must surface that loudly rather
  than silently dropping it. The admin should resolve problems before the final
  export.
- **Reproducible.** Exporting twice with no changes gives byte-identical
  `data.json` and the same `digest`.
- `digest` is the bundle's identity: the competition server records it and refuses
  to run from a different bundle once the festival has started.
- `bundle_version` changes on any breaking change to the shape.

### What the competition server does with it (specified there, summarised here)

- Verifies before use: `data_sha256`; every hash in `audio` present with matching
  size and sha256; strict running order (unique `order_number` at every level);
  rubric ids unique; every competition's `rubric_id` names a rubric in the festival;
  every judge criterion names a criterion of its rubric. Refuses the bundle with a
  clear message otherwise.
- Runs from `data.json` held in memory as static, read-only data; resolves each
  `rubric_id` into the same `Competition` objects as today, and does not load it
  into its database tables. It stores the digest and the exact `data.json` text in
  its database, so its backups are complete on their own.
- Any copy tool can move the files (USB, `cp`, `rsync -a --ignore-existing`, later
  an HTTPS pull); correctness is decided by the verification, not by the tool.

## 6. Audio

### Upload rules

- Accepted input: **mp3 or wav**, recognised by the file's first bytes, never by
  its name or content type. WAV: `RIFF....WAVE`. MP3: an `ID3` tag or an MPEG frame
  sync (`0xFF` followed by a byte with the top three bits set).
- Maximum size: 50 MB per file (configurable).
- One file per `(competition, competitor, kind)`; a new upload replaces the old.
- **Deadline:** uploads close at the **freeze** (section 8), which comes before the
  final export. After it, only an admin can replace a file, and only before the
  final export. (The competition server's own per-session upload cut-off does not
  apply to the portal: the bundle is final.)

### Loudness normalisation (the portal's job)

Done once, in the portal, right after upload, in a background worker. Not on the
competition server and not in the DJ's browser.

- **Tool:** ffmpeg `loudnorm`, two passes (measure, then apply with the measured
  values), linear mode where possible so dance music keeps its dynamics, with a
  true-peak limit.
- **Target:** one integrated loudness for all `music`, about -14 to -16 LUFS, true
  peak at or below -1 dBTP. Pick the number once, keep it in config, record it in
  the manifest.
- **Announcements** have their own target (decide deliberately; a voice at music
  level sounds like shouting).
- **Output:** a single format and sample rate for every file (for example mp3 192
  kbps at 44.1 kHz, or WAV). The sha256 in the bundle is the **normalised** file's.
- **Keep the original** next to the normalised file, so a different target can be
  applied later without asking competitors to re-upload.
- **States:** `processing` -> `ready` | `failed` (with a reason). A new upload
  starts again. Only `ready` files are exported.
- **Expectation:** files at the same LUFS sound about equally loud over their full
  length; very dynamic or very compressed tracks can still feel different by a
  decibel or two. Store `lufs` and `true_peak_db` per file and flag outliers (for
  example one that could not reach the target without heavy limiting).

## 7. Architecture (recommendation, not fixed)

- **Web app** serving the competitor and admin UI, plus an API.
- **Postgres** for the portal's own data.
- **Object/file storage** for originals and normalised audio, behind an interface so
  a bucket can replace the local disk.
- **Worker** that runs ffmpeg jobs from a queue (a table-backed queue is enough).
- **Exporter** (TypeScript), not one big SQL query:
  1. One `REPEATABLE READ` transaction; a few plain `SELECT`s per table (one
     consistent snapshot).
  2. Build the nested tree (section 5) from the snapshot, copying only the fields in
     section 4 (this enforces the privacy boundary). Write each rubric used by an
     exported competition once, under the festival.
  3. Validate with readable errors: strict running order (every session,
     competition and entry has an `order_number`, unique at its level), every
     `music` file `ready` with sha256 and size (the rest to `problems`), UTC times,
     and the rubric rules (every competition's rubric is in the export; judge
     criteria exist in their rubric).
  4. Serialise canonically: sorted keys, arrays in running order (`order_number`),
     UTC ISO timestamps, fixed formatting.
  5. Compute `data_sha256` and `digest`; write `manifest.json`.
  6. Write the folder (and the uncompressed zip).
  7. Record the export in an `exports` table: the exact `data.json` text (`text`,
     not `jsonb`, which reorders keys and breaks the digest), the digest,
     `generated_at`, and who ran it.
- Keep the bundle types, the validator and the serialiser in **one small module**
  that the competition server's loader can share, so the format is defined once. It
  lives in `shared/festival-bundle/` in the `sse-app` repo until the portal has its
  own repo, then it is published and both projects pin one version.
- **Score receiver** endpoint for section 9.
- Stack: TypeScript on Deno is the natural fit with the competition server, but
  nothing in the contract depends on it.
- Run single-instance first; add scale only when needed.

Security: server-side authorisation on every route (competitors see only their own
entries); upload size and rate limits; the file sniffing above on the server;
store only password hashes; HTTPS; the bundle download and the score receiver are
authenticated (a per-festival token) and logged.

## 8. Timeline, freeze and distribution

1. Registration opens. Competitors enter and upload; files are normalised as they
   arrive.
2. **Freeze** (set by the admin): registration and uploads close; the admin resolves
   `problems` and finalises the running order.
3. Export. **Dry run** at the venue a few days before with that bundle.
4. Final export. From here the bundle is final: there are no late changes. Day-of
   withdrawals are handled on the competition server by skipping the competitor.
5. Event; scores flow back (section 9).

Distribution, in order of build:

- **A (first): copy the folder.** USB stick, `cp`, or
  `rsync -a --ignore-existing audio/ venue:/srv/sse/audio/`. No code to write; works
  with no venue network; repeatable. The competition server's verification decides
  whether the copy is correct.
- **B (later): HTTPS pull.** The competition server fetches `manifest.json`, then
  only the missing hashes, from an authenticated portal endpoint. Outbound only (no
  SSH, works behind the venue's router), shows progress on its admin page, needs
  HTTP Range support for resuming large files.

## 9. Scores from the venue

The competition server pushes the festival's scores to the portal:

- **Snapshot push** over HTTPS every 30-60 s while it has internet: the whole set of
  scores (small: 500 entries x 3 judges x 4 criteria = 6,000 rows), skipped when
  its digest is unchanged. The portal **replaces** that festival's scores in one
  transaction, so missed pushes, corrections and deletes need no special handling.
- A **final full push** after the event is the authoritative results upload.
- Rows: `competition_id, competitor_id, judge_id, criteria_id, score` (one decimal,
  1-10), plus the bundle `digest` so scores from a different bundle are rejected.
- Optionally the venue's progress (open session, current competitor, actual start
  times) for a live view.
- The portal shows the time of the last push. It never has to be reachable for the
  event to run.

## 10. Non-functional requirements

- **Reliability of the hand-over:** the bundle is verified by digest and per-file
  hash on the venue side; a bad bundle is refused with a clear message.
- **Reproducibility:** exporting twice with no changes gives the same digest.
- **Privacy:** only section 4's fields cross the boundary.
- **Observability:** every export, audio job and score push is logged with its
  outcome.
- **Testing:** unit tests for sniffing, the exporter (same data -> same digest; any
  exported field changed -> different digest; private fields never appear),
  rubric references (each used rubric written once; a competition whose `rubric_id`
  is not in the festival's rubrics is refused), validation (duplicate `order_number`,
  missing file, file still `processing`, judge criteria not in the rubric);
  a fixture bundle shared with the competition server's loader tests; integration
  tests for upload -> normalise -> export with real ffmpeg on a short silent WAV;
  the score receiver (replace, digest mismatch rejected).

## 11. Milestones

1. Accounts, competitor creation, admin CRUD for the festival structure and running
   order.
2. Entry to a competition; upload with sniffing, size limit and the freeze deadline.
3. Normalisation worker, statuses, playback of the result.
4. Exporter and the bundle format, with a fixture and the shared module (agree it
   with the competition server's loader here).
5. Freeze workflow, problems report, dry-run support.
6. Score receiver and results view.
7. HTTPS bundle download (distribution B).

## 12. Open questions

- Hosting and whether ffmpeg is available there (decides worker design).
- Auth method (password vs magic link) and whether judges need accounts at all.
- Payments or ticketing, and whether registration is open to the public.
- Target loudness numbers and the output audio format.
- Whether the cloud needs live scores during the event (a public results page) or
  only a backup and the final results; live within seconds would justify an
  incremental push instead of snapshots.
