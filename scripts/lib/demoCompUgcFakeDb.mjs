/**
 * scripts/lib/demoCompUgcFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory fake of the Prisma client for the Demo Competition UGC Videos tests.
 * Emulates ONLY demo_comp_members (the owners; seeded by the test) and the five
 * demo_comp_ugc_* models, with exactly the operations the service uses:
 *   findUnique / findMany (equality, `in`, gt/gte/lt/lte/not, orderBy (array), take,
 *   select, include member) / count / create / update / upsert / createMany
 *   ({ skipDuplicates }) / groupBy (_sum, _max) / $transaction(fn) (serialised,
 *   rolled back on throw) / $executeRaw (advisory locks only).
 * Unique keys: event.idempotencyKey, plan (videoId, dayKey). The CHECK constraints
 * and the append-only guards of migration 20261116_demo_comp_ugc_videos are emulated.
 *
 * STRICT: any other model THROWS — the real UGC tables, orders, affiliates, wallets,
 * payouts, rewards, AND the member / brand demo stats (demoCompEvent, demoCompDailyPlan,
 * demoCompBrand…). Every access is logged (reads + writes) for the isolation tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto';

export const UGC_FAKE_MODELS = ['demoCompMember', 'demoCompUgcSettings', 'demoCompUgcVideo', 'demoCompUgcVideoVersion', 'demoCompUgcDailyPlan', 'demoCompUgcEvent'];
export const UGC_MODELS = UGC_FAKE_MODELS.filter((m) => m !== 'demoCompMember');

const clone = (v) => structuredClone(v);
const toMs = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : v);
const isDateStr = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v);

function matchValue(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond && !cond.in.some((x) => toMs(x) === toMs(actual))) return false;
    if ('gt' in cond && !(actual != null && toMs(actual) > toMs(cond.gt))) return false;
    if ('gte' in cond && !(actual != null && toMs(actual) >= toMs(cond.gte))) return false;
    if ('lt' in cond && !(actual != null && toMs(actual) < toMs(cond.lt))) return false;
    if ('lte' in cond && !(actual != null && toMs(actual) <= toMs(cond.lte))) return false;
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

class FakeError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

export function makeUgcFakeDb({ checks = true } = {}) {
  let store = Object.fromEntries(UGC_FAKE_MODELS.map((m) => [m, []]));
  const stats = { locks: [], txCount: 0, writes: [], reads: [] };
  let txChain = Promise.resolve();
  const REWARD = (v) => [5, 6, 7].includes(v);
  const RANGE = (lo, hi) => Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi >= lo && hi <= 1000;

  function checkRow(model, r) {
    if (!checks) return;
    const fail = (what) => { throw new FakeError('P2010', `CHECK violation on ${model}: ${what}`); };
    if (model === 'demoCompUgcVideo') {
      const t = String(r.title ?? '').trim();
      if (!(t.length >= 1 && t.length <= 120)) fail('title');
      if (!RANGE(r.minDailySales, r.maxDailySales) || !REWARD(r.rewardPerSaleMad)) fail('video settings');
      if (r.archivedAt != null && r.active !== false) fail('archived video must be disabled');
      if (!store.demoCompMember.some((m) => m.id === r.memberId)) throw new FakeError('P2003', 'FK video.member');
    }
    if (model === 'demoCompUgcVideoVersion' && (!RANGE(r.minDailySales, r.maxDailySales) || !REWARD(r.rewardPerSaleMad))) fail('version settings');
    if (model === 'demoCompUgcDailyPlan') {
      if (!(r.targetSales >= r.minSales && r.targetSales <= r.maxSales) || !RANGE(r.minSales, r.maxSales)) fail('target within min/max');
      if (!(toMs(r.dayEnd) > toMs(r.dayStart))) fail('day bounds');
    }
    if (model === 'demoCompUgcEvent') {
      if (!(r.quantity >= 1 && r.quantity <= 3) || !REWARD(r.rewardPerSaleMad)) fail('quantity / reward');
      if (r.rewardCents !== r.quantity * r.rewardPerSaleMad * 100) fail('reward formula');
      if (!store.demoCompUgcDailyPlan.some((p) => p.id === r.planId)) throw new FakeError('P2003', 'FK event.plan');
    }
    if (model === 'demoCompUgcSettings' && !(Number.isInteger(r.targetVideoCount) && r.targetVideoCount >= 1 && r.targetVideoCount <= 100)) fail('target count');
  }

  function uniqueClash(model, r) {
    const rows = store[model];
    if (model === 'demoCompUgcEvent') return rows.some((x) => x.idempotencyKey === r.idempotencyKey);
    if (model === 'demoCompUgcDailyPlan') return rows.some((x) => x.videoId === r.videoId && x.dayKey === r.dayKey);
    return rows.some((x) => x.id === r.id);
  }

  const PERMANENT = new Set(['demoCompUgcEvent', 'demoCompUgcDailyPlan', 'demoCompUgcVideoVersion']);

  function withDefaults(model, data) {
    const now = new Date();
    const r = { id: data.id ?? (model === 'demoCompUgcSettings' ? 'ugc' : randomUUID()), ...clone(data) };
    if (model === 'demoCompMember') Object.assign(r, { photoUrl: null, active: true, archivedAt: null, createdAt: now, updatedAt: now, ...r });
    if (model === 'demoCompUgcVideo') Object.assign(r, { videoUrl: null, thumbnailUrl: null, active: true, minDailySales: 3, maxDailySales: 15, rewardPerSaleMad: 5, sortOrder: 0, generatedThrough: null, archivedAt: null, createdAt: now, updatedAt: now, ...r });
    if (model === 'demoCompUgcSettings') Object.assign(r, { enabled: false, targetVideoCount: 20, initializedAt: null, resumedAt: null, pausedAt: null, lastRunAt: null, lastRunEvents: 0, lastError: null, updatedAt: now, ...r });
    if (!('createdAt' in r) && model !== 'demoCompUgcSettings') r.createdAt = now;
    for (const k of Object.keys(r)) if (isDateStr(r[k])) r[k] = new Date(r[k]);
    return r;
  }

  function insert(model, data) {
    const r = withDefaults(model, data);
    if (uniqueClash(model, r)) throw new FakeError('P2002', `unique ${model}`);
    checkRow(model, r);
    store[model].push(r);
    stats.writes.push(`${model}.create`);
    return r;
  }

  const withMember = (out, row, include) => {
    if (include?.member) out.member = project(clone(store.demoCompMember.find((m) => m.id === row.memberId) ?? null), include.member.select);
    return out;
  };

  function delegate(model) {
    const read = (op) => stats.reads.push(`${model}.${op}`);
    return {
      findUnique: async ({ where, select, include }) => {
        read('findUnique');
        const r = store[model].find((x) => matches(x, where));
        if (!r) return null;
        return project(withMember({ ...clone(r) }, r, include), select);
      },
      findMany: async ({ where, orderBy, take, select, include } = {}) => {
        read('findMany');
        let rows = sortRows(store[model].filter((x) => matches(x, where)), orderBy);
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => project(withMember({ ...clone(r) }, r, include), select));
      },
      count: async ({ where } = {}) => { read('count'); return store[model].filter((x) => matches(x, where)).length; },
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
        for (const k of Object.keys(next)) if (isDateStr(next[k])) next[k] = new Date(next[k]);
        checkRow(model, next);
        Object.assign(r, next);
        stats.writes.push(`${model}.update`);
        return clone(r);
      },
      upsert: async ({ where, create, update }) => {
        const r = store[model].find((x) => matches(x, where));
        if (r) { Object.assign(r, clone(update)); stats.writes.push(`${model}.upsert`); return clone(r); }
        return clone(insert(model, create));
      },
      delete: async () => { throw new FakeError('P2010', `${model}: the UGC service never deletes`); },
      groupBy: async ({ by, where, _sum, _max }) => {
        read('groupBy');
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
          return out;
        });
      },
    };
  }

  const base = Object.fromEntries(UGC_FAKE_MODELS.map((m) => [m, delegate(m)]));
  base.$executeRaw = async (strings, ...values) => {
    const sql = strings.join('?');
    if (!/pg_advisory_xact_lock/.test(sql)) throw new Error(`unexpected raw SQL: ${sql}`);
    stats.locks.push(values[0]);
    return 1;
  };
  base.$transaction = async (fn) => {
    const run = txChain.then(async () => {
      stats.txCount += 1;
      const snapshot = clone(store);
      try { return await fn(db); } catch (err) { store = snapshot; throw err; }
    });
    txChain = run.catch(() => {});
    return run;
  };

  /** Test-only seeding of a demo member (bypasses the write log: the service itself never writes members). */
  const seedMember = (data = {}) => { const r = withDefaults('demoCompMember', { name: 'Member', ...data }); store.demoCompMember.push(r); return clone(r); };
  const setMember = (id, patch) => { Object.assign(store.demoCompMember.find((m) => m.id === id), clone(patch)); };

  const db = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === '_store') return store;
      if (prop === '_stats') return stats;
      if (prop === '_seedMember') return seedMember;
      if (prop === '_setMember') return setMember;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: demo UGC touched "${String(prop)}"`);
    },
  });
  store.demoCompUgcSettings.push(withDefaults('demoCompUgcSettings', { id: 'ugc' }));
  return db;
}
