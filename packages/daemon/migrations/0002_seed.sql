-- Seed data (PRD §13, §11): the principal, the initial categories, the expenses matter
-- and the starting permission. Nothing personal: the principal is named 'principal'.
INSERT INTO entities (kind, name, created_at)
VALUES ('principal', 'principal', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO categories (name, created_at)
VALUES
  ('supermercado', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('restaurantes', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO matters (title, status, opened_at)
VALUES ('Keep my expenses', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Register without asking if the lines sum to the total and the category comes from a policy.
-- The core authority check reads exactly these keys. No limits, no expiry.
INSERT INTO permissions (operation, conditions_json, granted_at)
VALUES (
  'register_expense',
  '{"lines_sum_to_total": true, "category_basis": "policy"}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
