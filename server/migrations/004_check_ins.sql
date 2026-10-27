-- PBI-4: photo check-ins. A goal now has one stake photo and many check-in
-- photos. Existing rows are stakes, which the column default records.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'stake';
ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_kind_check;
ALTER TABLE photos ADD CONSTRAINT photos_kind_check CHECK (kind IN ('stake', 'checkin'));

-- 001 declared goal_id UNIQUE inline, which Postgres named photos_goal_id_key.
-- Only stakes stay one per goal.
ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_goal_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS photos_one_stake_per_goal_idx ON photos(goal_id) WHERE kind = 'stake';
-- The unique constraint also indexed every goal_id lookup, including the
-- ON DELETE CASCADE from goals; keep an index for check-in photos too.
CREATE INDEX IF NOT EXISTS photos_goal_idx ON photos(goal_id);

CREATE TABLE IF NOT EXISTS check_ins (
  id UUID PRIMARY KEY,
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL UNIQUE REFERENCES photos(id) ON DELETE CASCADE,
  -- The calendar date in the goal's time zone when the check-in was made.
  local_date DATE NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One check-in per goal per local day, including for weekly goals.
  UNIQUE (goal_id, local_date)
);
CREATE INDEX IF NOT EXISTS check_ins_goal_date_idx ON check_ins(goal_id, local_date DESC);
