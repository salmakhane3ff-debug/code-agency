/**
 * scripts/lib/demoCompFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory fake of the Prisma client for the Demo Competition tests. Emulates
 * ONLY the demo_comp_* models and exactly the operations the service uses:
 *   findUnique / findMany (equality, `in`, gt/gte/lt/lte, orderBy, take, select,
 *   include owner) / count / create / update / upsert / delete (FK RESTRICT +
 *   CASCADE) / createMany({ skipDuplicates }) / groupBy (_sum, _max, _count) /
 *   $transaction(fn) (serialised, rolled back on throw) / $executeRaw (locks).
 * Unique keys: event.idempotencyKey, plan (stream, profileKey, dayKey).
 * The CHECK constraints of migration 20261113 are emulated on insert, and the
 * append-only guards on update / delete.
 *
 * STRICT: any other model (orders, affiliates, payouts…) THROWS — the isolation
 * guarantee of the demo engine is tested through this proxy.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto';

export const DEMO_COMP_MODELS = ['demoCompMember', 'demoCompMemberVersion', 'demoCompBrand', 'demoCompBrandVersion', 'demoCompDailyPlan', 'demoCompEvent', 'demoCompEngine'];

const clone = (v) => structuredClone(v);
const toMs = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-/.test(v) ? Date.parse(v) : v);

function matchValue(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond && !cond.in.some((x) => toMs(x) === toMs(actual))) return false;
    if ('gt' in cond && !(toMs(actual) > toMs(cond.gt))) return false;
    if ('gte' in cond && !(toMs(actual) >= toMs(cond.gte))) return false;
    if ('lt' in cond && !(toMs(actual) < toMs(cond.lt))) return false;
    if ('lte' in cond && !(toMs(actual) <= toMs(cond.lte))) return false;
    if ('not' in cond && toMs(actual ?? null) === toMs(cond.not)) return false;
    return true;
  }
  return toMs(actual ?? null) === toMs(cond ?? null);
}
const matches = (row, where = {}) => Object.entries(where).every(([k, c]) => matchValue(row[k], c));

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const x = toMs(a[k]), y = toMs(b[k]);
      if (x < y) return dir === 'desc' ? 1 : -1;
      if (x > y) return dir === 'desc' ? -1 : 1;
    }
    return 0;
  });
}

const project = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row);

class FakeError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

export function makeDemoCompFakeDb({ checks = true } = {}) {
  let store = Object.fromEntries(DEMO_COMP_MODELS.map((m) => [m, []]));
  const stats = { locks: [], txCount: 0, writes: [] };
  let txChain = Promise.resolve();

  const BPS = (v) => Number.isInteger(v) && v >= 1 && v <= 10000;
  const PRICE = (v) => Number.isInteger(v) && v >= 1 && v <= 10_000_000;
  const RANGE = (lo, hi) => Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi >= lo && hi <= 1000;

  function checkRow(model, r) {
    if (!checks) return;
    const fail = (what) => { throw new FakeError('P2010', `CHECK violation on ${model}: ${what}`); };
    if (model === 'demoCompEvent') {
      if (!(r.quantity >= 1 && r.quantity <= 3)) fail('quantity');
      if (!PRICE(r.priceCents) || !BPS(r.allocationBps)) fail('price/bps');
      if (r.earningsCents !== Math.round((r.quantity * r.priceCents * r.allocationBps) / 10000)) fail('earnings formula');
      const brand = r.eventType === 'BRAND_SALE';
      if (brand ? !(r.brandId && !r.memberId) : !(['PERSONAL_SALE', 'NETWORK_SALE'].includes(r.eventType) && r.memberId && !r.brandId)) fail('event stream / owner');
    }
    if (model === 'demoCompDailyPlan') {
      if (!(r.targetOrders >= r.minOrders && r.targetOrders <= r.maxOrders)) fail('target within min/max');
      if (!(toMs(r.dayEnd) > toMs(r.dayStart))) fail('day bounds');
      const brand = r.stream === 'BRAND';
      if (brand ? !(r.brandId && !r.memberId && r.profileKey === r.brandId) : !(r.memberId && !r.brandId && r.profileKey === r.memberId)) fail('plan stream / owner');
    }
    if (model === 'demoCompMember' || model === 'demoCompMemberVersion') {
      if (!RANGE(r.minDailyOrders, r.maxDailyOrders) || !PRICE(r.priceCents) || !BPS(r.allocationBps)) fail('member settings');
      if (!RANGE(r.networkMinDailyOrders, r.networkMaxDailyOrders)) fail('network range');
      if ((r.networkPriceCents == null) !== (r.networkAllocationBps == null)) fail('network rate pair');
    }
    if (model === 'demoCompBrand' || model === 'demoCompBrandVersion') {
      if (!RANGE(r.minDailyOrders, r.maxDailyOrders) || !PRICE(r.priceCents) || !BPS(r.allocationBps)) fail('brand settings');
    }
    // Same as demo_comp_engine_check: each default allocation 1..10000 bps on its own (separate streams, no combined cap).
    if (model === 'demoCompEngine' && (!BPS(r.defaultMemberBps) || !BPS(r.defaultBrandBps))) fail('engine defaults');
    // Same as demo_comp_{members,brands}_archive_check: an archived profile is always disabled.
    if ((model === 'demoCompMember' || model === 'demoCompBrand') && r.archivedAt != null && r.active !== false) fail('archived profile must be disabled');
  }

  function uniqueClash(model, r) {
    const rows = store[model];
    if (model === 'demoCompEvent') return rows.some((x) => x.idempotencyKey === r.idempotencyKey);
    if (model === 'demoCompDailyPlan') return rows.some((x) => x.stream === r.stream && x.profileKey === r.profileKey && x.dayKey === r.dayKey);
    return rows.some((x) => x.id === r.id);
  }

  const PERMANENT = new Set(['demoCompEvent', 'demoCompDailyPlan', 'demoCompMemberVersion', 'demoCompBrandVersion']);

  function withDefaults(model, data) {
    const now = new Date();
    const r = { id: data.id ?? (model === 'demoCompEngine' ? 'engine' : randomUUID()), ...clone(data) };
    if (model === 'demoCompMember') Object.assign(r, { active: true, minDailyOrders: 5, maxDailyOrders: 30, priceCents: 30000, allocationBps: 3000, networkAffiliates: 0, networkMinDailyOrders: 0, networkMaxDailyOrders: 0, networkPriceCents: null, networkAllocationBps: null, personalGeneratedThrough: null, networkGeneratedThrough: null, archivedAt: null, photoUrl: null, createdAt: now, updatedAt: now, ...r });
    if (model === 'demoCompBrand') Object.assign(r, { active: true, minDailyOrders: 5, maxDailyOrders: 30, priceCents: 30000, allocationBps: 7000, generatedThrough: null, archivedAt: null, imageUrl: null, createdAt: now, updatedAt: now, ...r });
    if (model === 'demoCompEngine') Object.assign(r, { enabled: false, defaultPriceCents: 30000, defaultMemberBps: 3000, defaultBrandBps: 7000, initializedAt: null, resumedAt: null, pausedAt: null, lastRunAt: null, lastRunEvents: 0, lastError: null, updatedAt: now, ...r });
    if (!('createdAt' in r)) r.createdAt = now;
    for (const k of Object.keys(r)) if (typeof r[k] === 'string' && /^\d{4}-\d\d-\d\dT/.test(r[k])) r[k] = new Date(r[k]);
    return r;
  }

  function insert(model, data) {
    const r = withDefaults(model, data);
    if (model === 'demoCompBrand' && !store.demoCompMember.some((m) => m.id === r.ownerId)) throw new FakeError('P2003', 'FK owner');
    if (uniqueClash(model, r)) throw new FakeError('P2002', `unique ${model}`);
    checkRow(model, r);
    store[model].push(r);
    stats.writes.push(`${model}.create`);
    return r;
  }

  function cascadeDelete(model, row) {
    if (model === 'demoCompMember') {
      if (store.demoCompBrand.some((b) => b.ownerId === row.id)) throw new FakeError('P2003', 'FK RESTRICT brands.owner');
      store.demoCompMemberVersion = store.demoCompMemberVersion.filter((v) => v.memberId !== row.id);
      store.demoCompEvent = store.demoCompEvent.filter((e) => e.memberId !== row.id);
      store.demoCompDailyPlan = store.demoCompDailyPlan.filter((p) => p.memberId !== row.id);
    }
    if (model === 'demoCompBrand') {
      store.demoCompBrandVersion = store.demoCompBrandVersion.filter((v) => v.brandId !== row.id);
      store.demoCompEvent = store.demoCompEvent.filter((e) => e.brandId !== row.id);
      store.demoCompDailyPlan = store.demoCompDailyPlan.filter((p) => p.brandId !== row.id);
    }
  }

  function delegate(model) {
    return {
      findUnique: async ({ where, select, include }) => {
        const r = store[model].find((x) => matches(x, where));
        if (!r) return null;
        const out = { ...clone(r) };
        if (include?.owner) out.owner = project(clone(store.demoCompMember.find((m) => m.id === r.ownerId)), include.owner.select);
        return project(out, select);
      },
      findMany: async ({ where, orderBy, take, select, include } = {}) => {
        let rows = sortRows(store[model].filter((x) => matches(x, where)), orderBy);
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => {
          const out = { ...clone(r) };
          if (include?.owner) out.owner = project(clone(store.demoCompMember.find((m) => m.id === r.ownerId)), include.owner.select);
          return project(out, select);
        });
      },
      count: async ({ where } = {}) => store[model].filter((x) => matches(x, where)).length,
      create: async ({ data }) => clone(insert(model, data)),
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const d of data) {
          const r = withDefaults(model, d);
          if (uniqueClash(model, r)) { if (skipDuplicates) continue; throw new FakeError('P2002', `unique ${model}`); }
          checkRow(model, r);
          store[model].push(r);
          count += 1;
        }
        stats.writes.push(`${model}.createMany`);
        return { count };
      },
      update: async ({ where, data }) => {
        if (PERMANENT.has(model)) throw new FakeError('P2010', `${model} is permanent demo history (UPDATE rejected)`);
        const r = store[model].find((x) => matches(x, where));
        if (!r) throw new FakeError('P2025', 'not found');
        const next = { ...r, ...clone(data), updatedAt: new Date() };
        for (const k of Object.keys(next)) if (typeof next[k] === 'string' && /^\d{4}-\d\d-\d\dT/.test(next[k])) next[k] = new Date(next[k]);
        checkRow(model, next);
        Object.assign(r, next);
        stats.writes.push(`${model}.update`);
        return clone(r);
      },
      upsert: async ({ where, create, update }) => {
        const r = store[model].find((x) => matches(x, where));
        if (r) { Object.assign(r, clone(update)); return clone(r); }
        return clone(insert(model, create));
      },
      delete: async ({ where }) => {
        if (PERMANENT.has(model)) throw new FakeError('P2010', `${model} is permanent demo history (DELETE rejected)`);
        const r = store[model].find((x) => matches(x, where));
        if (!r) throw new FakeError('P2025', 'not found');
        cascadeDelete(model, r);
        store[model] = store[model].filter((x) => x !== r);
        stats.writes.push(`${model}.delete`);
        return clone(r);
      },
      groupBy: async ({ by, where, _sum, _max, _count }) => {
        const groups = new Map();
        for (const r of store[model].filter((x) => matches(x, where))) {
          const key = by.map((k) => r[k]).join('|');
          if (!groups.has(key)) groups.set(key, { keys: Object.fromEntries(by.map((k) => [k, r[k]])), rows: [] });
          groups.get(key).rows.push(r);
        }
        return [...groups.values()].map(({ keys, rows }) => {
          const out = { ...keys };
          if (_sum) out._sum = Object.fromEntries(Object.keys(_sum).map((k) => [k, rows.reduce((a, r) => a + (r[k] ?? 0), 0)]));
          if (_max) out._max = Object.fromEntries(Object.keys(_max).map((k) => [k, rows.reduce((a, r) => (a === null || toMs(r[k]) > toMs(a) ? r[k] : a), null)]));
          if (_count) out._count = { _all: rows.length };
          return out;
        });
      },
    };
  }

  const base = Object.fromEntries(DEMO_COMP_MODELS.map((m) => [m, delegate(m)]));
  base.$executeRaw = async (strings, ...values) => {
    const sql = strings.join('?');
    if (!/pg_advisory_xact_lock/.test(sql)) throw new Error(`unexpected raw SQL: ${sql}`);
    stats.locks.push(values[0]);
    return 1;
  };
  base.$transaction = async (fn) => {
    // Serialised like a lock-protected section; rolled back on throw.
    const run = txChain.then(async () => {
      stats.txCount += 1;
      const snapshot = clone(store);
      try {
        return await fn(db);
      } catch (err) {
        store = snapshot;
        throw err;
      }
    });
    txChain = run.catch(() => {});
    return run;
  };

  const db = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === '_store') return store;
      if (prop === '_stats') return stats;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: demo competition touched "${String(prop)}"`);
    },
  });
  // Engine row exists after the migration.
  store.demoCompEngine.push(withDefaults('demoCompEngine', { id: 'engine' }));
  return db;
}
