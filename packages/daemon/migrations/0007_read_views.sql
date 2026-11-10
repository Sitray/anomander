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
