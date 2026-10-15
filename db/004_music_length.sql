-- An entry's duration comes from its music, never typed in. The worker measures
-- each normalised file (audio_files.seconds) and copies the music's length,
-- rounded to whole seconds, into entries.duration: a cache that keeps session
-- length sums cheap. 0 means the music is not ready yet.

ALTER TABLE audio_files ADD COLUMN seconds DOUBLE PRECISION
  CHECK (seconds IS NULL OR seconds >= 0);
ALTER TABLE entries ALTER COLUMN duration SET DEFAULT 0;
COMMENT ON COLUMN entries.duration IS
  'Length of the entry''s music in whole seconds (0 until it is ready); set by the worker';
