# Data model

The schema follows from the 16 data classes of the [ontology](ontology.md). The core idea: **an append-only ledger of assertions** (`assertions`) and, on top of it, tables of what is currently believed (`expenses`, `purchase_lines`) that always state their mode. A stored inference is still an inference, because its mode travels with it.

The database is one SQLite file, opened with `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON` and `PRAGMA recursive_triggers = ON` (without it, `REPLACE` would bypass the ledger triggers).

Model login credentials are not in the database: they live in their own file at `ANOMANDER_AUTH_PATH` (PRD R-27 AC5).

How the tables relate:

```mermaid
erDiagram
    entities ||--o{ expenses : "merchant of"
    categories ||--o{ expenses : "classifies"
    documents ||--o| expenses : "claims"
    expenses ||--o{ purchase_lines : "contains"
    assertions ||--o{ assertions : "supersedes"
    assertions ||--o{ assertions : "confirms"
    assertions ||--o{ policies : "declares"
    matters ||--o{ proposals : "groups"
    proposals ||--o| pending_decisions : "asks about"
    proposals ||--o| actions : "becomes"
    actions ||--o{ expenses : "creates"
    assertions ||--o| actions : "verifies"
    assertions ||--o| pending_decisions : "answers"
```

`assertions` also points to any subject (an expense, a purchase line, a document) through `subject_type` and `subject_id`; that link is not drawn because it is polymorphic. `permissions` is read by the authority check and referenced as `permission:<id>` in `actions.authorized_by`.

```sql
-- World
CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('principal', 'merchant')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE categories (           -- created only by the principal
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name = lower(name)),  -- 'supermercado', 'restaurantes'
  created_at TEXT NOT NULL
);

CREATE TABLE documents (            -- the receipt; images are temporary (R-8)
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('receipt')),
  received_at TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'telegram:<message_id>' or 'telegram:album:<media_group_id>'
  image_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('queued', 'read', 'unreadable', 'discarded')),
  keep_until TEXT,                  -- set only while queued (R-8 AC2)
  image_deleted_at TEXT
);

-- Truth: append-only ledger; only status may change
CREATE TABLE assertions (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL,       -- 'expense', 'purchase_line', 'document'...
  subject_id INTEGER,
  predicate TEXT NOT NULL,          -- 'total', 'merchant', 'category', 'line'...
  value_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('observed', 'declared', 'inferred', 'confirmed')),
  actor TEXT NOT NULL CHECK (actor IN ('principal', 'source', 'code', 'processor')),
  source TEXT NOT NULL,
  basis_json TEXT,                  -- what an inference rests on
  confidence REAL,
  valid_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('current', 'confirmed', 'refuted', 'expired')),
  supersedes_id INTEGER REFERENCES assertions(id),
  confirms_id INTEGER REFERENCES assertions(id),   -- set only when mode = 'confirmed'
  created_at TEXT NOT NULL,
  CHECK ((mode = 'confirmed') = (confirms_id IS NOT NULL))
);

CREATE TRIGGER assertions_no_delete
BEFORE DELETE ON assertions
BEGIN
  SELECT RAISE(ABORT, 'assertions are append-only');
END;

CREATE TRIGGER assertions_status_only
BEFORE UPDATE ON assertions
WHEN NEW.id IS NOT OLD.id
  OR NEW.subject_type IS NOT OLD.subject_type
  OR NEW.subject_id IS NOT OLD.subject_id
  OR NEW.predicate IS NOT OLD.predicate
  OR NEW.value_json IS NOT OLD.value_json
  OR NEW.mode IS NOT OLD.mode
  OR NEW.actor IS NOT OLD.actor
  OR NEW.source IS NOT OLD.source
  OR NEW.basis_json IS NOT OLD.basis_json
  OR NEW.confidence IS NOT OLD.confidence
  OR NEW.valid_at IS NOT OLD.valid_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.supersedes_id IS NOT OLD.supersedes_id
  OR NEW.confirms_id IS NOT OLD.confirms_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'only assertions.status may change');
END;

-- Currently believed, with mode
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  merchant_id INTEGER REFERENCES entities(id),
  occurred_on TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  category_id INTEGER REFERENCES categories(id),   -- NULL = uncategorized
  category_basis TEXT CHECK (category_basis IN ('declared', 'policy', 'inferred')),
  mode TEXT NOT NULL CHECK (mode IN ('declared', 'inferred', 'corroborated', 'confirmed')),
  document_id INTEGER REFERENCES documents(id),    -- NULL for text expenses
  status TEXT NOT NULL CHECK (status IN ('pending', 'current', 'refuted')),
  created_by_action_id INTEGER REFERENCES actions(id),
  created_at TEXT NOT NULL
);

CREATE TABLE purchase_lines (
  id INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id),
  product_name TEXT NOT NULL,       -- as printed on the receipt
  quantity REAL NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL
);

-- Work and knowledge
CREATE TABLE matters (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,              -- 'Keep my expenses'
  status TEXT NOT NULL CHECK (status IN ('open', 'active', 'waiting', 'resolved', 'abandoned')),
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE policies (             -- declared only by the principal
  id INTEGER PRIMARY KEY,
  rule_json TEXT NOT NULL,          -- {"merchant": "Mercadona", "category": "supermercado"}
  declared_by_assertion_id INTEGER NOT NULL REFERENCES assertions(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Operations
CREATE TABLE permissions (          -- granted only by the principal
  id INTEGER PRIMARY KEY,
  operation TEXT NOT NULL,          -- 'register_expense'
  conditions_json TEXT NOT NULL,    -- {"lines_sum_to_total": true, "category_basis": "policy"}
  limits_json TEXT,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER REFERENCES matters(id),
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  basis_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'authorized', 'asked', 'rejected', 'executed')),
  created_at TEXT NOT NULL
);

CREATE TABLE pending_decisions (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id),
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,       -- ["Apuntar", "Corregir", "Descartar"]
  status TEXT NOT NULL CHECK (status IN ('open', 'awaiting_text', 'answered', 'expired')),
  channel_ref TEXT,                 -- the message that shows it, e.g. 'telegram:<message_id>' (R-17 AC2)
  awaiting_since TEXT,              -- set while status = 'awaiting_text' (R-17 AC6)
  answer_assertion_id INTEGER REFERENCES assertions(id),
  created_at TEXT NOT NULL
);

-- At most one decision waits for text at a time (R-17 AC3)
CREATE UNIQUE INDEX one_awaiting_text
  ON pending_decisions (status) WHERE status = 'awaiting_text';

CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  authorized_by TEXT NOT NULL,      -- 'permission:<id>' or 'principal'
  executed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('executed', 'verified', 'failed')),
  verification_assertion_id INTEGER REFERENCES assertions(id)
);

-- Read by the app-of-apps supermarket dashboard
CREATE VIEW supermarket_purchases AS
SELECT
  l.product_name AS producto,
  l.quantity     AS cantidad,
  l.amount_cents AS precio_cents,
  m.name         AS comercio,
  e.occurred_on  AS fecha,
  e.mode         AS modo
FROM purchase_lines l
JOIN expenses e   ON e.id = l.expense_id
JOIN entities m   ON m.id = e.merchant_id
JOIN categories c ON c.id = e.category_id
WHERE c.name = 'supermercado'
  AND e.status = 'current';
```

The daily AI budget (PRD R-12) has its own table, added by the migration `0003_ai_budget.sql`:

```sql
-- Daily AI budget (R-12): processor calls per day in TZ
CREATE TABLE ai_usage (
  day TEXT PRIMARY KEY,             -- 'YYYY-MM-DD' in TZ
  calls INTEGER NOT NULL,           -- processor calls counted that day (R-12 AC1)
  limit_notified INTEGER NOT NULL DEFAULT 0  -- 1 once S-10 was sent that day (R-12 AC2)
);
```

Conversation memory (PRD R-23) keeps the erasable text of each `memory` assertion beside the append-only ledger, added by the migration `0004_conversation_memory.sql`. A confirmed forget deletes the `memory_texts` row, the triggers remove it from the FTS5 index, and the assertion stays as `expired` with no text:

```sql
-- Conversation memory (R-23): the text of each `memory` assertion, erased on a confirmed forget
CREATE TABLE memory_texts (
  assertion_id INTEGER PRIMARY KEY REFERENCES assertions(id),
  text TEXT NOT NULL,               -- the fact, as the processor worded it
  quote TEXT NOT NULL               -- the words of the message it rests on
);

-- FTS5 index of the memory text, kept in step with memory_texts by triggers
CREATE VIRTUAL TABLE memory_search USING fts5(
  text, content = 'memory_texts', content_rowid = 'assertion_id', tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO memory_search (memory_search, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER memory_texts_indexed AFTER INSERT ON memory_texts BEGIN
  INSERT INTO memory_search (rowid, text) VALUES (NEW.assertion_id, NEW.text);
END;

CREATE TRIGGER memory_texts_unindexed AFTER DELETE ON memory_texts BEGIN
  INSERT INTO memory_search (memory_search, rowid, text) VALUES ('delete', OLD.assertion_id, OLD.text);
END;
```

Reminders and tasks (PRD R-25) are added by the migration `0005_reminders.sql`. Each one rests on a `reminder` assertion about it (subject type `reminder`, mode `declared`, actor `principal`, source the Telegram message); the assertion's value only points at the row, so the text lives in `reminders` alone. A task is a row with no `due_at`:

```sql
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
```

In `recurrence_json`, `freq` is `daily`, `weekly` with `days` (1 Monday to 7 Sunday) or `monthly` with `day` (1 to 31); `time` is local `HH:mm` in `TZ`. A repeating reminder's `due_at` is always its next occurrence.

The weekly summary (PRD R-10 AC5-AC6) works the same way with no table of its own: the principal's "Sí" to S-74 inserts a `permissions` row with operation `send_weekly_summary` and `conditions_json` `{}`, and S-9 is sent only while one is in force.

The morning digest (PRD R-26) needs no table for its permission: the principal's "Sí" to S-53 inserts a row in `permissions` with operation `send_morning_digest` and `conditions_json` `{"time": "HH:mm"}` (local time in `TZ`), revoking the earlier one, and turning it off sets `revoked_at`. The days it was sent are added by the migration `0006_digest_sends.sql`:

```sql
-- Morning digest (R-26 AC6): one row per day it was handled (sent, or had nothing to send), so it is never sent twice
CREATE TABLE digest_sends (
  day TEXT PRIMARY KEY,             -- 'YYYY-MM-DD' in TZ
  sent_at TEXT NOT NULL
);
```

A row is written only after the digest's send succeeded, so a failed one is tried again on the next minute. A day when every part of the digest is empty sends nothing but gets its row all the same: its digest was the empty one, so something added later that morning does not bring a late "Buenos días". The table holds no digest text.

Ledger read access (RA-1 of the draft [`read-access-prd.md`](read-access-prd.md), milestone M5b) adds three views in the migration `0007_read_views.sql`. They are the whole contract for readers such as the daemon's read API: only `current` expenses are served, every row carries its `modo`, money stays in cents and `fecha` is the `YYYY-MM-DD` day in `TZ` of `expenses.occurred_on`. `origen` is `texto` for an expense with no document and `ticket` for a receipt. A missing merchant or category is `NULL`, never a dropped row. `pendientes_de_confirmar` always has exactly one row, `0` and `0` when nothing is pending:

```sql
-- Ledger read access (RA-1): what other applications read; they never touch the tables
-- One row per current expense
CREATE VIEW gastos AS
SELECT
  e.id          AS id,
  e.occurred_on AS fecha,
  m.name        AS comercio,
  c.name        AS categoria,
  e.total_cents AS total_cents,
  e.mode        AS modo,
  CASE WHEN e.document_id IS NULL THEN 'texto' ELSE 'ticket' END AS origen
FROM expenses e
LEFT JOIN entities m   ON m.id = e.merchant_id
LEFT JOIN categories c ON c.id = e.category_id
WHERE e.status = 'current';

-- One row per purchase line of a current expense, any category
CREATE VIEW lineas_de_compra AS
SELECT
  l.expense_id   AS gasto_id,
  l.product_name AS producto,
  l.quantity     AS cantidad,
  l.amount_cents AS precio_cents,
  m.name         AS comercio,
  c.name         AS categoria,
  e.occurred_on  AS fecha,
  e.mode         AS modo
FROM purchase_lines l
JOIN expenses e        ON e.id = l.expense_id
LEFT JOIN entities m   ON m.id = e.merchant_id
LEFT JOIN categories c ON c.id = e.category_id
WHERE e.status = 'current';

-- Always one row: how many expenses wait for the principal, and their total
CREATE VIEW pendientes_de_confirmar AS
SELECT
  count(*)                      AS cantidad,
  coalesce(sum(total_cents), 0) AS total_cents
FROM expenses
WHERE status = 'pending';
```

`supermarket_purchases` stays as it was. Unlike `0003` to `0006`, `0007` is not yet a block of PRD §13: it joins it when the draft moves into `PRD.md`.

Schema decisions:

- **Money is stored in cents** (`INTEGER`), never as decimals, so that sums add up exactly.
- **Nothing is deleted or overwritten in `assertions`.** A correction of mine creates a new assertion that points to the earlier one (`supersedes_id`) and marks it as refuted. Two triggers enforce it: only `status` may change, and no row may be deleted.
- **A confirmation points at what it confirms** (`confirms_id`). Its actor is `principal` when I confirm, or `code` when a deterministic check corroborates the assertion.
- **Receipt images are temporary.** `documents.status` and `keep_until` track the queue used when the daily AI budget runs out (PRD R-8, R-12). A `queued` document without `keep_until` is being read; one left that way by an earlier run is abandoned at startup (PRD R-19 AC5).
- **Reminders keep their time in UTC and their repetition in local time.** `due_at` is the next instant to send, so the every-minute send reads one indexed column; `recurrence_json.time` stays local in `TZ`, so a daily 9:00 is still 9:00 after a daylight-saving change (PRD R-25).
- **Permissions say what the principal authorized, not what code may decide.** The morning digest's time is a condition of its permission, so a new time is a new permission the principal grants with "Sí", never an edit of the old row (PRD R-26 AC3, §8.1).
- **The daily AI budget is counted in the database** (`ai_usage`, one row per day in `TZ`), so a restart does not reset it, and `limit_notified` makes the limit notice go out once a day (PRD R-12).
- **At most one pending decision waits for my text** (`awaiting_text`), enforced by a partial unique index (PRD R-17).
- **The database does not stop the processor from writing "confirmed"; the code does.** The processor never writes directly: it returns inferences and proposals, and only the code that checks authority turns them into rows.
- **Readers only read views.** The dashboard reads `supermarket_purchases` and the read API reads `gastos`, `lineas_de_compra` and `pendientes_de_confirmar`; neither touches the tables, so changing the internal schema does not break the app of apps as long as the views keep returning the same columns. Changing or removing a view column breaks a consumer.
- **Category names and view columns are in Spanish** because they are the principal's own scheme and the dashboard's labels. The rest of the schema is in English.
