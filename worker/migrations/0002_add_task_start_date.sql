-- Availability is separate from the deadline: a task appears once start_date
-- is reached, while due_date continues to drive due and overdue reminders.

ALTER TABLE tasks ADD COLUMN start_date TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_space_status_start
  ON tasks(space_id, status, start_date, created_at);
