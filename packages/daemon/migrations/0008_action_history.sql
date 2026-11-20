-- What ANOMANDER did (DK-14): one row per look at the screen, task on the computer or task with connections, written when it ended; erased on a confirmed forget
CREATE TABLE action_history (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('screen', 'computer', 'connect')),
  door TEXT NOT NULL CHECK (door IN ('app', 'telegram')),
  task TEXT NOT NULL,               -- the principal's words: the question or the task, never what was typed, captured or answered
  outcome TEXT NOT NULL,            -- how it ended, as a code word: 'done', 'cannot', 'answer', 'stopped', 'failed'...
  steps INTEGER,                    -- a task on the computer: the steps performed; NULL otherwise
  calls_json TEXT,                  -- a task with connections: [{"server": "notes", "tool": "create", "allowed": false}], never arguments or results; NULL otherwise
  ended_at TEXT NOT NULL            -- UTC
);

-- The text interpreter reads the latest ones (DK-14 AC3)
CREATE INDEX action_history_ended ON action_history (ended_at);
