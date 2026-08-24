-- The Worker stores a deliberately small shared mirror. The local IndexedDB
-- remains the source of truth for task editing; D1 only supports the partner
-- view, comments, and server-side reminders.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS spaces (
  space_id TEXT PRIMARY KEY,
  pairing_secret_hash TEXT NOT NULL UNIQUE,
  recovery_secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
  access_token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'partner')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🌱',
  due_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_role TEXT NOT NULL CHECK (owner_role IN ('owner', 'partner')),
  revision INTEGER NOT NULL DEFAULT 0,
  reminder_mode TEXT NOT NULL DEFAULT 'none' CHECK (reminder_mode IN ('none', 'default', 'custom')),
  reminder_at TEXT,
  overdue_at TEXT,
  reminder_sent_at TEXT,
  reminder_claimed_at TEXT,
  overdue_reminder_sent_at TEXT,
  overdue_reminder_claimed_at TEXT,
  PRIMARY KEY (space_id, task_id)
);

CREATE TABLE IF NOT EXISTS comments (
  space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('owner', 'partner')),
  author_label TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, comment_id),
  FOREIGN KEY (space_id, task_id) REFERENCES tasks(space_id, task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_devices_access_token_hash
  ON devices(access_token_hash);

CREATE INDEX IF NOT EXISTS idx_tasks_space_status_updated
  ON tasks(space_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_tasks_reminder_due
  ON tasks(reminder_at, reminder_claimed_at, space_id, task_id)
  WHERE status = 'open' AND reminder_at IS NOT NULL AND reminder_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_overdue_at
  ON tasks(overdue_at, overdue_reminder_claimed_at, space_id, task_id)
  WHERE status = 'open' AND overdue_at IS NOT NULL AND overdue_reminder_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comments_task_created
  ON comments(space_id, task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_space_device
  ON push_subscriptions(space_id, device_id);
