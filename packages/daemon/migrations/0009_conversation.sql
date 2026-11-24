-- The conversation with the principal (DK-16, R-16 AC3): one row per message from either door, so the app shows it again and the text interpreter picks up its recent turns after a restart; erased on "Borrar conversación", on a confirmed forget, and after 90 days
CREATE TABLE conversation (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused; a principal's message is followed by the reply it got
  sender TEXT NOT NULL CHECK (sender IN ('principal', 'anomander')),
  door TEXT NOT NULL CHECK (door IN ('app', 'telegram')),
  text TEXT NOT NULL,               -- what was said; a receipt is its `[foto de ticket]` line, a press its `[botón: …]` line; never an image or a text pasted for a login
  buttons_json TEXT,                -- a reply's buttons: [{"label": "Sí", "data": "decision:3:0"}] or {"label", "url"}; NULL when it has none
  channel_ref TEXT,                 -- a reply's own reference once it was delivered: `desktop:<uuid>` or `telegram:<message_id>`; NULL otherwise
  sent_at TEXT NOT NULL             -- UTC
);

-- The recent turns are the latest minutes; the retention job erases by age
CREATE INDEX conversation_sent ON conversation (sent_at);
