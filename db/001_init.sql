-- Registration portal schema (portal.md sections 3, 4, 6, 9).
-- Every timestamp is TIMESTAMPTZ. Running-order uniqueness is DEFERRABLE so a
-- reorder can renumber a whole level inside one transaction.

-- ---------------------------------------------------------------------------
-- People and authentication
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,                          -- NULL: magic-link only
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Browser sessions. Only the sha256 of the cookie value is stored.
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

-- One-time links: magic sign-in and password reset.
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('magic', 'reset')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Festival structure (admin)
-- ---------------------------------------------------------------------------
CREATE TABLE festivals (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  registration_open BOOLEAN NOT NULL DEFAULT FALSE,
  -- Registration and competitor uploads close at this time (section 8).
  freeze_at         TIMESTAMPTZ,
  -- Competitors see their running position once this is set.
  order_published   BOOLEAN NOT NULL DEFAULT FALSE,
  -- sha256 of the per-festival token for the bundle download and score receiver.
  api_token_hash    TEXT UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tracks (
  id          BIGSERIAL PRIMARY KEY,
  festival_id BIGINT NOT NULL REFERENCES festivals ON DELETE CASCADE,
  name        TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE sessions (
  id           BIGSERIAL PRIMARY KEY,
  track_id     BIGINT NOT NULL REFERENCES tracks ON DELETE CASCADE,
  name         TEXT NOT NULL,
  start_time   TIMESTAMPTZ NOT NULL,           -- planned
  order_number INT NOT NULL CHECK (order_number > 0),
  CONSTRAINT sessions_order UNIQUE (track_id, order_number)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rubrics (
  id          BIGSERIAL PRIMARY KEY,
  festival_id BIGINT NOT NULL REFERENCES festivals ON DELETE CASCADE,
  name        TEXT NOT NULL
);

CREATE TABLE criteria (
  id        BIGSERIAL PRIMARY KEY,
  rubric_id BIGINT NOT NULL REFERENCES rubrics ON DELETE CASCADE,
  name      TEXT NOT NULL,
  weight    DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (weight > 0)
);

-- Judges exist only so the organiser can assign them to rubrics.
CREATE TABLE judges (
  id          BIGSERIAL PRIMARY KEY,
  festival_id BIGINT NOT NULL REFERENCES festivals ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT                             -- private, never exported
);

-- Which criteria each judge scores. A judge belongs to a rubric when they
-- score at least one of its criteria.
CREATE TABLE judge_criteria (
  judge_id     BIGINT NOT NULL REFERENCES judges ON DELETE CASCADE,
  criterion_id BIGINT NOT NULL REFERENCES criteria ON DELETE CASCADE,
  PRIMARY KEY (judge_id, criterion_id)
);

CREATE TABLE competitions (
  id           BIGSERIAL PRIMARY KEY,
  session_id   BIGINT NOT NULL REFERENCES sessions ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rubric_id    BIGINT NOT NULL REFERENCES rubrics,
  -- Competitors can enter while the festival's registration is open and this is set.
  open         BOOLEAN NOT NULL DEFAULT TRUE,
  order_number INT NOT NULL CHECK (order_number > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT competitions_order UNIQUE (session_id, order_number)
    DEFERRABLE INITIALLY DEFERRED
);

-- ---------------------------------------------------------------------------
-- Competitors and entries
-- ---------------------------------------------------------------------------
CREATE TABLE competitors (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,                    -- display name, exported
  type       TEXT NOT NULL CHECK (type IN ('individual', 'couple', 'team')),
  created_by BIGINT NOT NULL REFERENCES users,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Member accounts of a competitor (private, never exported).
CREATE TABLE competitor_members (
  competitor_id BIGINT NOT NULL REFERENCES competitors ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (competitor_id, user_id)
);
CREATE INDEX competitor_members_user ON competitor_members (user_id);

CREATE TABLE entries (
  id             BIGSERIAL PRIMARY KEY,
  competition_id BIGINT NOT NULL REFERENCES competitions ON DELETE CASCADE,
  competitor_id  BIGINT NOT NULL REFERENCES competitors ON DELETE CASCADE,
  duration       INT NOT NULL CHECK (duration >= 0),      -- seconds
  order_number   INT NOT NULL CHECK (order_number > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competition_id, competitor_id),
  CONSTRAINT entries_order UNIQUE (competition_id, order_number)
    DEFERRABLE INITIALLY DEFERRED
);

-- ---------------------------------------------------------------------------
-- Audio (section 6). One row per (entry, kind); a new upload replaces the row.
-- Files live in storage under content-addressed keys.
-- ---------------------------------------------------------------------------
CREATE TABLE audio_files (
  id               BIGSERIAL PRIMARY KEY,
  entry_id         BIGINT NOT NULL REFERENCES entries ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('music', 'announce')),
  status           TEXT NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('processing', 'ready', 'failed')),
  reason           TEXT,                       -- why it failed
  original_key     TEXT NOT NULL,
  original_sha256  TEXT NOT NULL,
  original_bytes   BIGINT NOT NULL,
  original_name    TEXT NOT NULL,
  original_format  TEXT NOT NULL CHECK (original_format IN ('mp3', 'wav')),
  -- The normalised file: what is played and exported.
  storage_key      TEXT,
  sha256           TEXT,
  bytes            BIGINT,
  content_type     TEXT,
  target_lufs      DOUBLE PRECISION,
  lufs             DOUBLE PRECISION,
  true_peak_db     DOUBLE PRECISION,
  -- An outlier worth a look (heavy limiting, silent, far from the target).
  flag             TEXT,
  uploaded_by      BIGINT NOT NULL REFERENCES users,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  UNIQUE (entry_id, kind),
  CHECK (status <> 'ready' OR (sha256 IS NOT NULL AND bytes IS NOT NULL
                               AND storage_key IS NOT NULL))
);

-- Table-backed job queue for the normalisation worker.
CREATE TABLE audio_jobs (
  id            BIGSERIAL PRIMARY KEY,
  audio_file_id BIGINT NOT NULL REFERENCES audio_files ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts      INT NOT NULL DEFAULT 0,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX audio_jobs_queued ON audio_jobs (run_after) WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Exports (section 5, step 7)
-- ---------------------------------------------------------------------------
CREATE TABLE exports (
  id            BIGSERIAL PRIMARY KEY,
  festival_id   BIGINT NOT NULL REFERENCES festivals ON DELETE CASCADE,
  final         BOOLEAN NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL,
  digest        TEXT NOT NULL,
  data_sha256   TEXT NOT NULL,
  -- The exact bytes. TEXT, not JSONB: JSONB reorders keys and breaks the digest.
  data_text     TEXT NOT NULL,
  manifest_text TEXT NOT NULL,
  problem_count INT NOT NULL,
  folder        TEXT NOT NULL,                 -- the written bundle folder
  created_by    BIGINT REFERENCES users
);
CREATE INDEX exports_festival ON exports (festival_id, generated_at DESC);
-- At most one final export per festival: after it nothing changes.
CREATE UNIQUE INDEX exports_one_final ON exports (festival_id) WHERE final;

-- ---------------------------------------------------------------------------
-- Scores from the venue (section 9). Replaced as a whole on every push.
-- ---------------------------------------------------------------------------
CREATE TABLE scores (
  festival_id    BIGINT NOT NULL REFERENCES festivals ON DELETE CASCADE,
  competition_id BIGINT NOT NULL,
  competitor_id  BIGINT NOT NULL,
  judge_id       BIGINT NOT NULL,
  criteria_id    BIGINT NOT NULL,
  score          NUMERIC(3, 1) NOT NULL CHECK (score >= 1 AND score <= 10),
  PRIMARY KEY (festival_id, competition_id, competitor_id, judge_id, criteria_id)
);

CREATE TABLE skips (
  festival_id    BIGINT NOT NULL REFERENCES festivals ON DELETE CASCADE,
  session_id     BIGINT NOT NULL,
  competition_id BIGINT NOT NULL,
  competitor_id  BIGINT NOT NULL,
  stage          TEXT NOT NULL,
  actor          TEXT NOT NULL,
  reason         TEXT NOT NULL
);
CREATE INDEX skips_festival ON skips (festival_id);

-- Every push, accepted or not (observability).
CREATE TABLE score_pushes (
  id            BIGSERIAL PRIMARY KEY,
  festival_id   BIGINT REFERENCES festivals ON DELETE CASCADE,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted      BOOLEAN NOT NULL,
  error         TEXT,
  final         BOOLEAN NOT NULL DEFAULT FALSE,
  bundle_digest TEXT,
  digest        TEXT,
  sent_at       TIMESTAMPTZ,
  score_count   INT,
  skip_count    INT
);
CREATE INDEX score_pushes_festival ON score_pushes (festival_id, received_at DESC);

-- General event log: exports, audio jobs, freezes (observability).
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  festival_id BIGINT REFERENCES festivals ON DELETE CASCADE,
  user_id     BIGINT REFERENCES users ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_festival ON events (festival_id, at DESC);
