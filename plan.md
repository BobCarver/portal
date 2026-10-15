# Portal: what still needs doing

What is left after the first implementation (`4b3799f`) and the shared score
push (`0c97dc6`). The design is in [portal.md](portal.md). The items are grouped
by when they matter:

1. Before real competitors sign up
2. Before the event
3. Should do
4. Later
5. Decisions needed

Sizes are rough: **S** is under half a day, **M** a day or two, **L** more.

---

## 1. Before opening registration to real competitors

- [ ] **Send real email (M).** `ConsoleMailer` in [src/mail.ts](src/mail.ts) only
  prints messages to the server log. Magic links, password resets and the link
  `deno task admin` gives a new organiser go nowhere. A competitor who forgets
  their password cannot get back in.
  - Add a `Mailer` that uses SMTP or an email API (Postmark, SES, Resend…).
  - Add a `MAIL_FROM` setting and choose the mailer in `src/main.ts`.
  - Test that a failed send shows an error and is logged.

- [ ] **Hosting and HTTPS (M).** There is no Dockerfile or deployment setup.
  - Pick a host, with ffmpeg (libmp3lame) on it. This is open question 1 in
    portal.md.
  - Serve over HTTPS and set `BASE_URL=https://…`: that turns on secure cookies
    and puts the right address in emailed links.
  - Set `TRUST_PROXY=1` behind a reverse proxy, so rate limits see the real
    client address.
  - Add a health check (`GET /healthz`: database reachable, ffmpeg present) for
    the host to poll.
  - Check at startup that ffmpeg exists. Today a missing ffmpeg only shows up as
    every upload failing.

- [ ] **Backups (S).** Back up two things: the database, and the storage folder
  (`STORAGE_DIR`), which holds the competitors' originals and the normalised
  files. Restore both once, to check the backup works. Exports can be
  regenerated, but the final export's folder should be kept.

- [ ] **Uploads without holding the whole file in memory (M).**
  [src/routes/competitor.ts](src/routes/competitor.ts) reads the whole file
  into memory (`file.arrayBuffer()`). Ten 50 MB uploads at once means 500 MB of
  memory. Stream the upload to a temporary file instead: sniff the first bytes,
  hash while writing, then move the file into storage.

- [ ] **Account page (S).** Users cannot change their name, email or password
  while signed in; they can only reset the password through email. Add
  `/account` with those changes and a "sign out everywhere" button.

- [ ] **Decide who may register (S).** Registration is open to anyone with the
  address, and the email is not checked. To prevent invented addresses, require
  a click on an emailed link before the first entry. See also question 3 in
  section 5.

## 2. Before the event

- [ ] **Run sse-app's integration tests (S).** They have not been run since the
  score push moved into the shared module (`35448ee`) because they need Docker
  Postgres. Run `deno task test:integration` in sse-app.

- [ ] **Dry run at the venue (S).** Export a dry-run bundle and load it on the
  competition server: verify, run a session, push scores. Then check the
  results page here. Do it with the real festival, a few days before, as
  portal.md section 8 says.

- [ ] **Check the ranking (S).** The results page ranks by the sum of
  score × criterion weight over every judge (`tallyResults` in
  [src/scores.ts](src/scores.ts)). Check that this is how the competition
  server ranks, especially when judges score different numbers of criteria.
  Better still, move the calculation into the shared module, so both sides
  compute it the same way.

- [ ] **Stop edits during the final export (S).** An organiser's edit that
  starts just before the final export can commit after the export has taken
  its snapshot. The bundle would then not match the database.
  - Lock the festival row (`SELECT … FOR UPDATE`) in the export.
  - Do the same in every edit, or check again after the export.

- [ ] **Distribution B on the venue side (M, sse-app).** The portal serves
  `/api/bundle/…` with Range support, but the competition server has nothing
  that pulls from it. Until it does, bundles are copied by hand (USB, `rsync`),
  which is distribution A and works.

## 3. Should do

### Competitors

- [ ] **Compare the music's length with the duration (S).** When normalising,
  read the music's length with ffprobe and store it. Warn the competitor, and
  flag it for the organiser, when it is clearly longer than the stated
  performance duration.
- [ ] **Limit who can enter a competition (S).** Nothing stops an individual
  from entering "Latin couples". Add the competitor types each competition
  allows. An entry limit per competition could come with it.
- [ ] **Notification emails (M).** These need real email first.
  - Confirm each entry.
  - Tell the competitor when their music fails to process.
  - Remind competitors before the freeze about missing music.
  - Tell them when the running order is published.
- [ ] **Festival time zone (S).** Times are shown in the viewer's own zone, and
  an organiser's input is read in their browser's zone. A competitor abroad sees
  the session times converted to their zone. Store a time zone per festival and
  show times in it.

### Organisers

- [ ] **Manage users in the portal (S).** Promote or demote organisers and
  disable accounts from the admin pages. Today this needs `deno task admin` on
  the server.
- [ ] **Correct a final export (M).** A final export locks the festival for
  good. Allow an organiser, after confirming, to make a corrected final export.
  It would be recorded in the event log, and the venue would be warned that the
  digest changed. The competition server refuses a different bundle once the
  festival has started, so this only helps before the event.
- [ ] **Download the audio flags (S).** List or download every flagged file
  (heavy limiting, silent, far from the target), to review before the freeze.

### Operations

- [ ] **Clean up old data (S).** Delete expired rows in `auth_sessions` and
  `auth_tokens`, finished rows in `audio_jobs`, and old `events`. None of these
  are ever deleted.
- [ ] **Disk use of exports (M).** Each export copies every audio file twice:
  once into its folder, once into its zip. Ten dry runs of a large festival use
  ten times the audio's size.
  - Hard-link the folder's files to storage, or write the zip from storage.
  - Let organisers delete old dry-run exports.
- [ ] **Delete unused audio files (S).** Replaced or withdrawn files stay in
  storage forever. Delete files no row refers to, but keep any file used by the
  final export.
- [ ] **Security headers (S).** Add a Content Security Policy. The pages have
  two small inline scripts: move them to a static file, or allow them with a
  nonce.
- [ ] **Separate venue tokens (S).** One token per festival both downloads
  bundles and pushes scores. Use separate tokens, so a leaked download token
  cannot overwrite scores.

### Code and tests

- [ ] **CI (M).** Add a GitHub Actions workflow that checks out sse-app next to
  this repo, starts Postgres, installs ffmpeg and runs `deno task static` and
  `deno task test`.
- [ ] **Publish the shared module (M, both repos).** Publish
  `sse-app/shared/festival-bundle` as a versioned package (JSR) and pin a
  version in both `deno.json` files. The portal could then be cloned, built in
  CI and deployed without sse-app beside it. portal.md section 7 plans this.
- [ ] **Share the fixture bundle (S).** Use `fixtures/bundles/demo` in the
  competition server's loader tests too, as portal.md section 10 asks.
- [ ] **Split `src/routes/admin.ts` (S).** At about 2,000 lines it is hard to work
  on. Split it into overview, structure, rubrics, entries, export and results.
- [ ] **Templates and the formatter (S).** `deno fmt` reformats the inside of
  `html` templates, which makes some of them hard to read. Use
  `// deno-fmt-ignore` where it matters, or rename the template tag.
- [ ] **Tests that are missing (M).**
  - Browser tests of the main pages: Playwright is already set up in
    sse-app/node-tests.
  - Rate limits.
  - A zip over 4 GB (zip64), and an export with about 500 entries, to see how
    long it takes.
  - The worker retrying after a temporary error.

## 4. Later

- [ ] **Live view during the event.** The score push may later carry the venue's
  progress (open session, current competitor). Show it, with a public results
  page if that is wanted (question 5).
- [ ] **Payments and ticketing** (question 3).
- [ ] **More than one server instance.** Rate limits are kept in memory; move
  them to the database or Redis. The job queue already works with several
  workers.
- [ ] **Re-normalise everything at once.** If the loudness target changes,
  queue every file again. The originals are kept for exactly this.
- [ ] **Delete accounts and their data on request (privacy law).** Decide what
  happens to entries that are already in an exported bundle.

## 5. Decisions needed

From portal.md section 12, and from building the portal:

1. **Hosting.** Where does the portal run, and is ffmpeg available there? The
   current design assumes one server with ffmpeg.
2. **How to sign in.** Both password and magic link are built. Keep both? Must
   new accounts confirm their email before entering?
3. **Who may register.** Open to the public, or by invitation or an access code
   per festival? Are there fees, and how are they paid?
4. **Loudness.** Keep music at -15 LUFS, announcements at -20 LUFS, and mp3 at
   192 kbps / 44.1 kHz? Listen to some real tracks before deciding.
5. **Scores in the cloud.** Is a backup and the final results enough, or is a
   public results page needed during the event? Results within seconds would
   need an incremental push instead of snapshots.
6. **Ranking.** Is the weighted sum the official result? How are ties broken?
7. **Final export.** Is a locked final export acceptable, or must corrections
   be possible until the event starts? See "Correct a final export" in
   section 3.
8. **Pro-am rules.** A pro-am competition needs at least one professional and one
   amateur. Is a pro-am couple one of each, or can a pair be two professionals?
9. **Same-gender couples.** Men's couples and women's couples share one category
   (`same_gender`). Split them if the competition needs it.
10. **Names and rules.** Competition names carry the categories for people, and the
    rules are the fields. Should the portal warn when a name contradicts its rules
    (for example "Women" with gender set to open)?
