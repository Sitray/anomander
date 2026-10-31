-- Reminders and tasks (R-25): each one rests on a `reminder` assertion declared by the principal
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,               -- what to remember, quoted from the principal's message
  due_at TEXT,                      -- next time to send it, UTC; NULL for a task
  recurrence_json TEXT,             -- {"freq": "weekly", "days": [1, 4], "time": "08:00"}; NULL when it happens once
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'done', 'cancelled')),
  declared_by_assertion_id INTEGER NOT NULL REFERENCES assertions(id),
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  closed_at TEXT,                   -- when it became sent, done or cancelled
  CHECK (recurrence_json IS NULL OR due_at IS NOT NULL)
);

-- The every-minute send (R-25 AC7) reads only pending reminders that have a time
CREATE INDEX reminders_due ON reminders (due_at) WHERE status = 'pending' AND due_at IS NOT NULL;
