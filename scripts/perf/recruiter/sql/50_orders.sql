-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/50_orders.sql — step 50: affiliate_orders. Per affiliate the plan
-- fixes n_orders and rd (REAL delivered = status exactly 'delivered' AND isFake = false); rows
-- k = 1..rd are those, every other row is non-qualifying:
--   real rows   pending 22 %, confirmed 14 %, shipped 14 %, cancelled 18 %, canceled 6 %,
--               returned 9 %, refused 9 %, 'Delivered' (case variant) 4 %, 'on_hold' (unknown) 4 %
--   fake rows   (k > rd, k > 1, 23 % → ~10 % of all rows): 'delivered' 40 %, else the same distribution
-- orderId: a distinct uuid per row, except 25 % of the fake rows that reuse the orderId of the
-- affiliate's row 1 (always real) — an orderId shared by a fake and a real row.
-- Inserted in "createdAt" order (heap order = time order).
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

INSERT INTO affiliate_orders (id, "affiliateId", "orderId", "clientName", "clientPhone", "productTitle", total,
                              "commissionAmount", status, "ipAddress", "isSuspicious", "suspicionReason", "isFake", "createdAt")
SELECT o.id, o.aid, o.order_id, o.client_name, o.client_phone, o.product, o.total,
       round((o.total * 0.10)::numeric, 2)::double precision,
       o.status, o.ip, o.suspicious, CASE WHEN o.suspicious THEN 'SAME_IP_MULTIPLE_ORDERS' END, o.fake, o.at
FROM (
  SELECT b.*,
         CASE WHEN b.fake AND p5a_gen.u01('p5a:share:' || b.aid || ':' || b.k) < 0.25
              THEN p5a_gen.uuid4('p5a:oid:' || b.aid || ':1')
              ELSE p5a_gen.uuid4('p5a:oid:' || b.aid || ':' || b.k) END AS order_id,
         CASE
           WHEN b.k <= b.rd THEN 'delivered'
           WHEN b.fake AND b.us < 0.40 THEN 'delivered'
           ELSE CASE
             WHEN b.ux < 0.22 THEN 'pending'
             WHEN b.ux < 0.36 THEN 'confirmed'
             WHEN b.ux < 0.50 THEN 'shipped'
             WHEN b.ux < 0.68 THEN 'cancelled'
             WHEN b.ux < 0.74 THEN 'canceled'
             WHEN b.ux < 0.83 THEN 'returned'
             WHEN b.ux < 0.92 THEN 'refused'
             WHEN b.ux < 0.96 THEN 'Delivered'
             ELSE 'on_hold' END
         END AS status
  FROM (
    SELECT a.*,
           CASE WHEN a.fake THEN (a.us - 0.40) / 0.60 ELSE a.us END AS ux
    FROM (
      SELECT p.id AS aid, p.rd, k,
             p5a_gen.uuid4('p5a:ord:' || p.id || ':' || k) AS id,
             (k > p.rd AND k > 1 AND p5a_gen.u01('p5a:of:' || p.id || ':' || k) < 0.23) AS fake,
             p5a_gen.u01('p5a:os:' || p.id || ':' || k) AS us,
             p5a_gen.person('p5a:client:' || p.id || ':' || k) AS client_name,
             '06' || lpad((p5a_gen.h32('p5a:cp:' || p.id || ':' || k) % 100000000)::text, 8, '0') AS client_phone,
             (ARRAY['Montre Classique Homme', 'Sac a main cuir', 'Parfum Oud 100ml', 'Ecouteurs sans fil',
                    'Chaussures de sport', 'Lunettes de soleil', 'Coffret soin visage', 'Robe ete fleurie',
                    'Montre connectee', 'Portefeuille cuir', 'Babouches artisanales', 'Caftan brode'])[1 + p5a_gen.h32('p5a:prod:' || p.id || ':' || k) % 12] AS product,
             (99 + floor(901 * p5a_gen.u01('p5a:tot:' || p.id || ':' || k)))::double precision AS total,
             '10.' || (p5a_gen.h32('p5a:ip:' || p.id || ':' || k) % 256) || '.' || ((p5a_gen.h32('p5a:ip:' || p.id || ':' || k) / 256) % 256)
               || '.' || ((p5a_gen.h32('p5a:ip:' || p.id || ':' || k) / 65536) % 256) AS ip,
             p5a_gen.u01('p5a:susp:' || p.id || ':' || k) < 0.02 AS suspicious,
             (p.created_at + interval '1 hour' + interval '180 days' * p5a_gen.u01('p5a:ot:' || p.id || ':' || k))::timestamp(3) AS at
      FROM p5a_gen.plan p
      CROSS JOIN LATERAL generate_series(1, p.n_orders) k
    ) a
  ) b
) o
ORDER BY o.at, o.id;
