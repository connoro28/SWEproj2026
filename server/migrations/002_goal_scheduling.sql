-- PBI-2: goal schedules and activation. Existing rows are drafts with no
-- schedule, so every new column is nullable. Constraints are dropped before
-- being added because ADD CONSTRAINT has no IF NOT EXISTS form.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS frequency TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS times_per_week INTEGER;
-- A wall-clock time interpreted in the goal's own time zone.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS deadline_time TIME;
-- An IANA zone name. The API validates it; a CHECK constraint cannot.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

-- 001 declared status inline, which Postgres named goals_status_check.
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_status_check;
ALTER TABLE goals ADD CONSTRAINT goals_status_check CHECK (status IN ('draft', 'active'));

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_frequency_check;
ALTER TABLE goals ADD CONSTRAINT goals_frequency_check CHECK (frequency IS NULL OR frequency IN ('daily', 'weekly'));

-- IS NOT NULL is required: a CHECK passes when it evaluates to NULL, and
-- NULL BETWEEN 1 AND 7 is NULL.
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_times_per_week_check;
ALTER TABLE goals ADD CONSTRAINT goals_times_per_week_check CHECK (
  frequency IS NULL
  OR (frequency = 'weekly' AND times_per_week IS NOT NULL AND times_per_week BETWEEN 1 AND 7)
  OR (frequency = 'daily' AND times_per_week IS NULL)
);

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_active_schedule_check;
ALTER TABLE goals ADD CONSTRAINT goals_active_schedule_check CHECK (
  status = 'draft'
  OR (frequency IS NOT NULL AND deadline_time IS NOT NULL AND timezone IS NOT NULL AND activated_at IS NOT NULL)
);
