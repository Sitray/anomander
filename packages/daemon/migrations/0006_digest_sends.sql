-- Morning digest (R-26 AC6): one row per day it was handled (sent, or had nothing to send), so it is never sent twice
CREATE TABLE digest_sends (
  day TEXT PRIMARY KEY,             -- 'YYYY-MM-DD' in TZ
  sent_at TEXT NOT NULL
);
