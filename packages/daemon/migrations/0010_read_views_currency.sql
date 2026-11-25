-- Ledger read access (RA-1), backlog B71: an expense is in its own currency (DK-25), so every
-- view row that carries an amount says which, and a total never adds two currencies. Only the
-- views change; the stored rows stay as they are. The new columns go last, so a reader that
-- reads the earlier columns by position still finds them where they were.
DROP VIEW gastos;
DROP VIEW lineas_de_compra;
DROP VIEW pendientes_de_confirmar;

-- One row per current expense
CREATE VIEW gastos AS
SELECT
  e.id          AS id,
  e.occurred_on AS fecha,
  m.name        AS comercio,
  c.name        AS categoria,
  e.total_cents AS total_cents,
  e.mode        AS modo,
  CASE WHEN e.document_id IS NULL THEN 'texto' ELSE 'ticket' END AS origen,
  e.currency    AS moneda
FROM expenses e
LEFT JOIN entities m   ON m.id = e.merchant_id
LEFT JOIN categories c ON c.id = e.category_id
WHERE e.status = 'current';

-- One row per purchase line of a current expense, any category; its price is in the expense's
-- currency
CREATE VIEW lineas_de_compra AS
SELECT
  l.expense_id   AS gasto_id,
  l.product_name AS producto,
  l.quantity     AS cantidad,
  l.amount_cents AS precio_cents,
  m.name         AS comercio,
  c.name         AS categoria,
  e.occurred_on  AS fecha,
  e.mode         AS modo,
  e.currency     AS moneda
FROM purchase_lines l
JOIN expenses e        ON e.id = l.expense_id
LEFT JOIN entities m   ON m.id = e.merchant_id
LEFT JOIN categories c ON c.id = e.category_id
WHERE e.status = 'current';

-- Always one row: how many expenses wait for the principal, and their total. `total_cents` and
-- `moneda` are the total and its currency while every pending expense is in one currency (`0`
-- and NULL when none is pending), and both NULL when they are in several: never a sum across
-- currencies. `por_moneda` is a JSON array with the count and total of each currency, by code.
CREATE VIEW pendientes_de_confirmar AS
WITH por AS (
  SELECT currency AS moneda, count(*) AS cantidad, sum(total_cents) AS total_cents
  FROM expenses
  WHERE status = 'pending'
  GROUP BY currency
)
SELECT
  coalesce((SELECT sum(cantidad) FROM por), 0) AS cantidad,
  CASE (SELECT count(*) FROM por)
    WHEN 0 THEN 0
    WHEN 1 THEN (SELECT total_cents FROM por)
  END AS total_cents,
  CASE (SELECT count(*) FROM por)
    WHEN 1 THEN (SELECT moneda FROM por)
  END AS moneda,
  (SELECT json_group_array(
            json_object('moneda', moneda, 'cantidad', cantidad, 'total_cents', total_cents))
   FROM (SELECT moneda, cantidad, total_cents FROM por ORDER BY moneda)) AS por_moneda;
