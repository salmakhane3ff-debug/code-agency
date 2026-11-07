-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/10_plan.sql — step 10: the deterministic PLAN (no app table is
-- written here). One row per affiliate in p5a_gen.plan, the reward/reversal events in
-- p5a_gen.ledger_plan and the recruiter withdrawals in p5a_gen.withdrawal_plan.
--
-- Networks (S = scale):
--   mixed  S members: n = 1 is a root, every other node is a root with probability 5 %, else it
--          attaches to an EARLIER node 1 + floor((n-1)·u²) (u uniform from md5 → biased toward
--          older nodes: varied depth and fan-out); + U = max(2, S/1000) "unplaced" members in
--          2-cycles (parentIds pointing at each other, both linked).
--   wide   1 root + (S-1) direct children.
--   deep   one chain of S members (depth S).
-- Steady state for the CURRENT rules (v2: 5 real delivered orders + identity APPROVED; open rewards
-- are reversed below the threshold of THEIR version, v1 = 3, v2 = 5) holds by construction:
--   open reward of version v      → real delivered (rd) ≥ threshold(v)
--   no open reward, identity APPROVED → rd ≤ 4
-- Pools (mixed, placed members, ordered by md5('p5a:pool:'||id)):
--   award   identity PENDING, rd = 5, no open reward (25 % with closed cycles)
--   reverse identity APPROVED, rd = 5, open v2 reward (30 % after closed cycles)
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

CREATE TABLE p5a_gen.plan (
  shape         text    NOT NULL,
  n             int     NOT NULL,
  id            text    NOT NULL UNIQUE,
  recruiter_id  text    NOT NULL,
  username      text    NOT NULL,
  name          text    NOT NULL,
  phone         text,
  parent_n      int,
  parent_id     text,
  unplaced      boolean NOT NULL DEFAULT false,
  depth         int,
  created_at    timestamp(3) NOT NULL,
  is_active     boolean,
  pool          text,
  hist          text,
  closed_cycles int,
  identity      text,
  open_version  int,
  n0            int,
  rd0           int,
  rd            int,
  n_orders      int,
  PRIMARY KEY (shape, n)
);

-- ── network skeletons ────────────────────────────────────────────────────────
INSERT INTO p5a_gen.plan (shape, n, id, recruiter_id, username, name, phone, parent_n, unplaced, created_at)
SELECT r.shape, g,
       p5a_gen.uuid4('p5a:aff:' || r.shape || ':' || g),
       r.id,
       CASE r.shape WHEN 'mixed' THEN 'mx' WHEN 'wide' THEN 'wd' ELSE 'dp' END || lpad(g::text, 6, '0'),
       p5a_gen.person('p5a:name:' || r.shape || ':' || g),
       CASE WHEN p5a_gen.u01('p5a:hasphone:' || r.shape || ':' || g) < 0.5
            THEN '+2126' || lpad((r.idx * 1000000 + g)::text, 8, '0') END,
       CASE
         WHEN g = 1 THEN NULL
         WHEN r.shape = 'wide' THEN 1
         WHEN r.shape = 'deep' THEN g - 1
         WHEN p5a_gen.u01('p5a:mixed:root:' || g) < 0.05 THEN NULL
         ELSE 1 + floor((g - 1) * power(p5a_gen.u01('p5a:mixed:par:' || g), 2))::int
       END,
       false,
       (SELECT t FROM p5a_gen.timeline WHERE k = 'affiliates') + ((g - 1) * 3 + r.idx) * p.step_ms * interval '1 millisecond'
FROM p5a_gen.params p
CROSS JOIN p5a_gen.rec r
CROSS JOIN LATERAL generate_series(1, p.scale) g
WHERE r.shape IN ('mixed', 'wide', 'deep');

-- unplaced 2-cycles in the mixed network: (S+1 ↔ S+2), (S+3 ↔ S+4), …
INSERT INTO p5a_gen.plan (shape, n, id, recruiter_id, username, name, phone, parent_n, unplaced, created_at)
SELECT 'mixed', p.scale + i,
       p5a_gen.uuid4('p5a:aff:mixed:' || (p.scale + i)),
       r.id,
       'mx' || lpad((p.scale + i)::text, 6, '0'),
       p5a_gen.person('p5a:name:mixed:' || (p.scale + i)),
       NULL,
       CASE WHEN i % 2 = 1 THEN p.scale + i + 1 ELSE p.scale + i - 1 END,
       true,
       (SELECT t FROM p5a_gen.timeline WHERE k = 'affiliates') + ((p.scale + i - 1) * 3) * p.step_ms * interval '1 millisecond'
FROM p5a_gen.params p
CROSS JOIN p5a_gen.rec r
CROSS JOIN LATERAL generate_series(1, p.unplaced) i
WHERE r.shape = 'mixed';

CREATE INDEX ON p5a_gen.plan (shape, parent_n);
UPDATE p5a_gen.plan c SET parent_id = q.id FROM p5a_gen.plan q WHERE q.shape = c.shape AND q.n = c.parent_n;

-- depth as the service computes it (roots = 1); unplaced members stay NULL. Every placed node's
-- parent has a smaller n (mixed: an earlier node, wide: 1, deep: n-1), so one ascending pass
-- suffices (linear; a recursive CTE over the 100k-deep chain is quadratic here).
CREATE FUNCTION p5a_gen.fill_depth() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s   text;
  par int[];
  d   int[];
  m   int;
  i   int;
BEGIN
  FOR s IN SELECT DISTINCT shape FROM p5a_gen.plan LOOP
    SELECT array_agg(parent_n ORDER BY n), count(*), max(n) INTO par, i, m FROM p5a_gen.plan WHERE shape = s AND NOT unplaced;
    IF i <> m THEN RAISE EXCEPTION 'p5a: placed members of % are not 1..n', s; END IF;
    d := array_fill(0, ARRAY[m]);
    FOR i IN 1..m LOOP
      IF par[i] IS NULL THEN
        d[i] := 1;
      ELSIF par[i] >= i THEN
        RAISE EXCEPTION 'p5a: parent % of node % (%) is not earlier', par[i], i, s;
      ELSE
        d[i] := d[par[i]] + 1;
      END IF;
    END LOOP;
    UPDATE p5a_gen.plan p SET depth = x.depth
    FROM unnest(d) WITH ORDINALITY AS x(depth, n)
    WHERE p.shape = s AND p.n = x.n AND NOT p.unplaced;
  END LOOP;
END;
$$;
SELECT p5a_gen.fill_depth();

UPDATE p5a_gen.plan SET is_active = p5a_gen.u01('p5a:act:' || id) < 0.70;

-- ── scenario pools (mixed, placed members) ──────────────────────────────────
WITH ranked AS (
  SELECT n, row_number() OVER (ORDER BY md5('p5a:pool:' || id), id) AS r
  FROM p5a_gen.plan WHERE shape = 'mixed' AND NOT unplaced
)
UPDATE p5a_gen.plan p
SET pool = CASE WHEN ranked.r <= prm.award_pool THEN 'award' ELSE 'reverse' END
FROM ranked, p5a_gen.params prm
WHERE p.shape = 'mixed' AND p.n = ranked.n AND ranked.r <= prm.award_pool + prm.reverse_pool;

-- ── reward history class, identity ──────────────────────────────────────────
UPDATE p5a_gen.plan SET hist = CASE
    WHEN pool = 'award'   THEN CASE WHEN p5a_gen.u01('p5a:pa:' || id) < 0.25 THEN 'closed' ELSE 'none' END
    WHEN pool = 'reverse' THEN CASE WHEN p5a_gen.u01('p5a:pr:' || id) < 0.30 THEN 'closed_open' ELSE 'open' END
    ELSE CASE
      WHEN p5a_gen.u01('p5a:hist:' || id) < 0.18 THEN 'open'
      WHEN p5a_gen.u01('p5a:hist:' || id) < 0.24 THEN 'closed_open'
      WHEN p5a_gen.u01('p5a:hist:' || id) < 0.32 THEN 'closed'
      ELSE 'none' END
  END;
UPDATE p5a_gen.plan SET closed_cycles = CASE hist
    WHEN 'closed_open' THEN 1 + (p5a_gen.h32('p5a:kc:' || id) % 2)::int
    WHEN 'closed'      THEN 1 + (p5a_gen.h32('p5a:kc:' || id) % 3)::int
    ELSE 0 END;
-- Overall target 40 % APPROVED / 15 % PENDING / 10 % REJECTED / 35 % none (no row). Forced first:
-- every member with an open reward is APPROVED (it was approved before its reward), the award pool
-- is PENDING; the remaining ("free") members are drawn with the probabilities that make the TOTALS
-- land on the target at every scale (computed from the plan's own counts — deterministic).
WITH k AS (
  SELECT count(*)::float8 AS n,
         count(*) FILTER (WHERE pool = 'award')::float8 AS a,
         count(*) FILTER (WHERE pool IS DISTINCT FROM 'award' AND (pool = 'reverse' OR hist IN ('open', 'closed_open')))::float8 AS o
  FROM p5a_gen.plan
), pr AS (
  SELECT (0.40 * n - o) / (n - a - o) AS pa, (0.15 * n - a) / (n - a - o) AS pp, (0.10 * n) / (n - a - o) AS pj FROM k
)
UPDATE p5a_gen.plan SET identity = CASE
    WHEN pool = 'award' THEN 'PENDING'
    WHEN pool = 'reverse' OR hist IN ('open', 'closed_open') THEN 'APPROVED'
    WHEN p5a_gen.u01('p5a:idv:' || id) < pr.pa THEN 'APPROVED'
    WHEN p5a_gen.u01('p5a:idv:' || id) < pr.pa + pr.pp THEN 'PENDING'
    WHEN p5a_gen.u01('p5a:idv:' || id) < pr.pa + pr.pp + pr.pj THEN 'REJECTED'
    ELSE NULL END
FROM pr;

-- ── reward / reversal events (cycles per migration 20261110) ────────────────
CREATE TABLE p5a_gen.ledger_plan (
  affiliate_id text NOT NULL,
  recruiter_id text NOT NULL,
  cycle        int  NOT NULL,
  type         text NOT NULL,
  at           timestamp(3) NOT NULL,
  version      int  NOT NULL,
  amount       int  NOT NULL,
  is_open      boolean NOT NULL,
  legacy_key   boolean NOT NULL,
  PRIMARY KEY (affiliate_id, cycle, type)
);

WITH cyc AS (
  SELECT p.id, p.recruiter_id, p.created_at, p.pool, j,
         (p.hist IN ('open', 'closed_open') AND j = p.closed_cycles + 1) AS is_open,
         CASE WHEN j = 1 THEN interval '10 days' + interval '20 days' * p5a_gen.u01('p5a:gr:' || p.id || ':1')
              ELSE interval '5 days' + interval '25 days' * p5a_gen.u01('p5a:gr:' || p.id || ':' || j) END AS gr,
         interval '5 days' + interval '25 days' * p5a_gen.u01('p5a:gv:' || p.id || ':' || j) AS gv
  FROM p5a_gen.plan p
  CROSS JOIN LATERAL generate_series(1, p.closed_cycles + CASE WHEN p.hist IN ('open', 'closed_open') THEN 1 ELSE 0 END) j
  WHERE p.hist <> 'none'
), timed AS (
  SELECT c.*,
         (c.created_at + sum(c.gr) OVER (PARTITION BY c.id ORDER BY c.j)
                       + coalesce(sum(c.gv) OVER (PARTITION BY c.id ORDER BY c.j ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), interval '0'))::timestamp(3) AS r_at0
  FROM cyc c
), fixed AS (
  -- the reverse pool needs an OPEN v2 reward: an open reward planned before v2 moves after it
  SELECT t.*,
         CASE WHEN t.pool = 'reverse' AND t.is_open AND t.r_at0 < tl.t
              THEN (tl.t + interval '1 day' + interval '30 days' * p5a_gen.u01('p5a:prfix:' || t.id))::timestamp(3)
              ELSE t.r_at0 END AS r_at
  FROM timed t, p5a_gen.timeline tl WHERE tl.k = 'settings_v2'
), versioned AS (
  SELECT f.*,
         CASE WHEN f.r_at < (SELECT t FROM p5a_gen.timeline WHERE k = 'settings_v2') THEN 1 ELSE 2 END AS version,
         (f.r_at + f.gv)::timestamp(3) AS v_at,
         p5a_gen.u01('p5a:legacy:' || f.id) < 0.5 AS legacy_ok
  FROM fixed f
)
INSERT INTO p5a_gen.ledger_plan
SELECT id, recruiter_id, j, 'RECRUIT_REWARD', r_at, version, CASE version WHEN 1 THEN 5000 ELSE 7000 END, is_open,
       j = 1 AND legacy_ok AND r_at < (SELECT t FROM p5a_gen.timeline WHERE k = 'cycles_mig')
FROM versioned
UNION ALL
SELECT id, recruiter_id, j, 'REVERSAL', v_at, version, -(CASE version WHEN 1 THEN 5000 ELSE 7000 END), false,
       j = 1 AND legacy_ok AND v_at < (SELECT t FROM p5a_gen.timeline WHERE k = 'cycles_mig')
FROM versioned WHERE NOT is_open;

UPDATE p5a_gen.plan p SET open_version = lp.version
FROM p5a_gen.ledger_plan lp WHERE lp.affiliate_id = p.id AND lp.is_open;

-- ── orders: total count and REAL delivered count (status 'delivered' AND NOT isFake) ──
-- ~80 %: 0–7 orders; ~20 % "active sellers": 5–15 orders; 25–75 % of them real delivered.
UPDATE p5a_gen.plan SET n0 = CASE
    WHEN p5a_gen.u01('p5a:seller:' || id) < 0.20 THEN 5 + floor(11 * p5a_gen.u01('p5a:nord:' || id))::int
    ELSE floor(8 * p5a_gen.u01('p5a:nord:' || id))::int END;
UPDATE p5a_gen.plan SET rd0 = round(n0 * (0.25 + 0.5 * p5a_gen.u01('p5a:dshare:' || id)))::int;
UPDATE p5a_gen.plan SET rd = CASE
    WHEN pool IS NOT NULL THEN 5
    WHEN open_version IS NOT NULL THEN greatest(rd0, CASE open_version WHEN 1 THEN 3 ELSE 5 END)
    WHEN identity = 'APPROVED' THEN least(rd0, 4)
    ELSE rd0 END;
UPDATE p5a_gen.plan SET n_orders = CASE
    WHEN pool IS NOT NULL THEN greatest(n0, 6 + floor(3 * p5a_gen.u01('p5a:extra:' || id))::int)
    WHEN open_version IS NOT NULL THEN greatest(n0, rd + floor(3 * p5a_gen.u01('p5a:extra:' || id))::int)
    ELSE n0 END;

-- ── recruiter withdrawals: max(20, S/50) per recruiter WITH earnings (rec_empty has none, so it
-- has no withdrawal — a request needs a positive balance). Amounts are scaled so that the
-- CURRENT totals are consistent: reserved (pending + paid) ≈ 60 % of earned, paid ≤ earned.
CREATE TABLE p5a_gen.withdrawal_plan AS
WITH earned AS (
  SELECT recruiter_id, sum(amount)::bigint AS e FROM p5a_gen.ledger_plan GROUP BY recruiter_id
)
SELECT r.id AS recruiter_id, i,
       p5a_gen.uuid4('p5a:wd:' || r.id || ':' || i) AS id,
       CASE WHEN p5a_gen.u01('p5a:wds:' || r.id || ':' || i) < 0.55 THEN 'paid'
            WHEN p5a_gen.u01('p5a:wds:' || r.id || ':' || i) < 0.80 THEN 'pending'
            ELSE 'rejected' END AS status,
       greatest(100, round(0.60 * e.e / (0.80 * prm.withdrawals) * (0.5 + p5a_gen.u01('p5a:wda:' || r.id || ':' || i)) / 100) * 100)::bigint AS cents,
       ((SELECT t FROM p5a_gen.timeline WHERE k = 'withdrawals')
         + (i - 1) * (interval '333 days' / prm.withdrawals)
         + interval '1 hour' * floor(24 * p5a_gen.u01('p5a:wdt:' || r.id || ':' || i)))::timestamp(3) AS at,
       p5a_gen.uuid4('p5a:wdreq:' || r.id || ':' || i) AS request_id
FROM p5a_gen.rec r
JOIN earned e ON e.recruiter_id = r.id
CROSS JOIN p5a_gen.params prm
CROSS JOIN LATERAL generate_series(1, prm.withdrawals) i;
