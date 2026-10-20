CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'banned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_owner_idx ON goals(owner_id);

CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY,
  goal_id UUID NOT NULL UNIQUE REFERENCES goals(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep file removal requests in the same transaction as the photo deletion.
-- Cascades from DELETE users/goals fire this trigger too. The server removes
-- files only after the deletion has committed, and retries failures later.
CREATE TABLE IF NOT EXISTS photo_cleanup_queue (
  storage_key TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION queue_deleted_photo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO photo_cleanup_queue (storage_key) VALUES (OLD.storage_key)
  ON CONFLICT (storage_key) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER photos_queue_cleanup
AFTER DELETE ON photos
FOR EACH ROW EXECUTE FUNCTION queue_deleted_photo();
