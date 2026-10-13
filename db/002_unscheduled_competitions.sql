-- Competitions can exist before they are scheduled: they belong to the
-- festival directly, and get a session (and with it a track and a running
-- order number) later. The export refuses a competition with entries but no
-- session.

ALTER TABLE competitions ADD COLUMN festival_id BIGINT REFERENCES festivals ON DELETE CASCADE;
UPDATE competitions c SET festival_id = t.festival_id
  FROM sessions s JOIN tracks t ON t.id = s.track_id
  WHERE s.id = c.session_id;
ALTER TABLE competitions ALTER COLUMN festival_id SET NOT NULL;
CREATE INDEX competitions_festival ON competitions (festival_id);

-- Competitions no longer go when their session goes. With the check below a
-- session cannot be deleted while it has competitions (the admin pages
-- unschedule or move them first).
ALTER TABLE competitions DROP CONSTRAINT competitions_session_id_fkey;
ALTER TABLE competitions ADD CONSTRAINT competitions_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions ON DELETE SET NULL;

ALTER TABLE competitions ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE competitions ALTER COLUMN order_number DROP NOT NULL;
-- A scheduled competition has a running order number; an unscheduled one has none.
ALTER TABLE competitions ADD CONSTRAINT competitions_scheduled
  CHECK ((session_id IS NULL) = (order_number IS NULL));
