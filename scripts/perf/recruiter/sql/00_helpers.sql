-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/00_helpers.sql — Phase 6 Part 5a dataset generator, step 00.
-- Run by generate.mjs with psql -v scale=<1000|10000|100000> on a FRESH clone of p5a_base
-- (disposable cluster /tmp/p5a-pg, port 55510 only). Creates the private helper schema
-- p5a_gen (dropped again by 90_finalize.sql): parameters, deterministic hash helpers and the
-- four recruiters. Determinism: every pseudo-random value in the generator comes from md5 of a
-- fixed seed string (never random(), never now() in a stored value), so a rerun produces
-- identical data.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

DROP SCHEMA IF EXISTS p5a_gen CASCADE;
CREATE SCHEMA p5a_gen;

-- Scale parameters (spec: unplaced = max(2, S/1000); pools 40/20 at 1k, 1100/500 at 10k/100k;
-- recruiter withdrawals = max(20, S/50) per recruiter that has earnings).
CREATE TABLE p5a_gen.params (
  scale        int  NOT NULL CHECK (scale IN (1000, 10000, 100000)),
  unplaced     int  NOT NULL,
  award_pool   int  NOT NULL,
  reverse_pool int  NOT NULL,
  withdrawals  int  NOT NULL,
  step_ms      bigint NOT NULL   -- creation-time spacing of affiliates (3 networks interleaved over 150 days)
);
INSERT INTO p5a_gen.params
SELECT s, greatest(2, s / 1000),
       CASE WHEN s = 1000 THEN 40 ELSE 1100 END,
       CASE WHEN s = 1000 THEN 20 ELSE 500 END,
       greatest(20, s / 50),
       floor(150::numeric * 86400 * 1000 / (3 * (s + greatest(2, s / 1000))))::bigint
FROM (SELECT :scale::int AS s) x;

-- Timeline constants (all timestamps are UTC wall-clock, like Prisma's).
CREATE TABLE p5a_gen.timeline (k text PRIMARY KEY, t timestamp(3) NOT NULL);
INSERT INTO p5a_gen.timeline VALUES
  ('recruiters',  '2024-12-01 10:00:00'),   -- recruiters created (+ idx hours)
  ('settings_v1', '2024-12-15 09:00:00'),   -- v1: enabled, 50.00 MAD, 3 real delivered orders
  ('affiliates',  '2025-01-01 00:00:00'),   -- first affiliate; the networks grow over 150 days
  ('cycles_mig',  '2025-03-01 00:00:00'),   -- before this, cycle-1 rows may carry the legacy keys
  ('settings_v2', '2025-04-01 09:00:00'),   -- v2: enabled, 70.00 MAD, 5 real delivered orders (current)
  ('withdrawals', '2025-02-01 00:00:00');   -- recruiter withdrawals spread over 333 days from here

-- Deterministic hash helpers (inlinable SQL, no FROM clause).
CREATE FUNCTION p5a_gen.h32(seed text) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT ('x' || substr(md5(seed), 1, 8))::bit(32)::bigint $$;
CREATE FUNCTION p5a_gen.u01(seed text) RETURNS double precision
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT ('x' || substr(md5(seed), 1, 8))::bit(32)::bigint::double precision / 4294967296.0::double precision $$;
-- A version-4-shaped UUID (like Prisma's uuid()) derived from md5(seed).
CREATE FUNCTION p5a_gen.uuid4(seed text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT (overlay(overlay(md5(seed) PLACING '4' FROM 13 FOR 1)
                 PLACING substr('89ab', (('x' || substr(md5(seed), 17, 1))::bit(4)::int % 4) + 1, 1) FROM 17 FOR 1))::uuid::text $$;
-- A realistic person name from fixed lists (split_part keeps the function inlinable).
CREATE FUNCTION p5a_gen.person(seed text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT split_part('Youssef,Fatima,Mohamed,Khadija,Amine,Salma,Omar,Imane,Hamza,Sara,Mehdi,Nadia,Karim,Laila,Ayoub,Hajar,Anas,Zineb,Reda,Meryem',
                          ',', (1 + ('x' || substr(md5(seed || ':f'), 1, 8))::bit(32)::bigint % 20)::int)
            || ' ' ||
               split_part('El Amrani,Benali,Alaoui,Bennani,Tazi,Idrissi,Chraibi,Berrada,El Fassi,Lahlou,Ouazzani,Kettani,Sefrioui,Naciri,Bouzidi,Haddad,Ziani,Mansouri,Rami,Jebli',
                          ',', (1 + ('x' || substr(md5(seed || ':l'), 1, 8))::bit(32)::bigint % 20)::int) $$;

-- The four recruiters: three networks of S affiliates each + one with an empty network.
CREATE TABLE p5a_gen.rec (
  shape      text PRIMARY KEY,
  idx        int  NOT NULL,
  id         text NOT NULL UNIQUE,
  username   text NOT NULL,
  name       text NOT NULL,
  phone      text NOT NULL,
  rib        text NOT NULL,
  created_at timestamp(3) NOT NULL
);
INSERT INTO p5a_gen.rec
SELECT shape, idx, p5a_gen.uuid4('p5a:rec:' || shape), 'rec_' || shape, 'Recruiter ' || initcap(shape),
       '+2125' || lpad((90000000 + idx)::text, 8, '0'),
       '0115' || lpad(p5a_gen.h32('p5a:rib:' || shape)::text, 20, '0'),
       (SELECT t FROM p5a_gen.timeline WHERE k = 'recruiters') + idx * interval '1 hour'
FROM (VALUES ('mixed', 0), ('wide', 1), ('deep', 2), ('empty', 3)) v(shape, idx);

-- Fixed bcrypt-format hashes (the DB only accepts bcrypt shapes for recruiters; affiliates get an
-- unusable one, like recruiterCreateAffiliate). Never a real credential.
CREATE TABLE p5a_gen.consts (k text PRIMARY KEY, v text NOT NULL);
INSERT INTO p5a_gen.consts VALUES
  ('recruiter_hash', '$2b$12$r3RUlCDYzAzpLYnKdxR1HeQCd0GLeVAsT8XF/RX3DYCH5x.Qdrht2'),
  ('affiliate_hash', '$2b$12$Q5n0J7cX2oFQ1oQf6b0m7e0rT5mVJxQ0yq7YbU3o9JgQe2mJr8m1W');
