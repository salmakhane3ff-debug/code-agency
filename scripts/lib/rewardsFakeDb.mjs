/**
 * scripts/lib/rewardsFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory stand-in for the Prisma client, covering only what the rewards
 * services use. Faithful on the points that matter for correctness tests:
 *   • $transaction rolls back every write made inside it when it throws
 *     (undo log), like a real database transaction
 *   • upsert inside a transaction takes a lock on that row, held until the
 *     transaction ends (models Postgres' row lock), so concurrent Promise.all
 *     calls genuinely interleave and queue
 *   • `LOCK TABLE "affiliate_orders" IN SHARE MODE` (via $executeRaw) blocks
 *     every OTHER client's affiliateOrder write until the locking transaction
 *     ends; reads are not blocked — like Postgres' SHARE mode
 *   • pg_try_advisory_xact_lock (via $queryRaw) — non-blocking, held until the
 *     transaction ends, refused (locked: false) while another tx holds it
 *   • stats.log records every call in order; stats.hooks['table.method'] lets a
 *     test pause a call to force a specific interleaving
 *   • unique constraints throw P2002; createMany({skipDuplicates}) skips
 *   • updateMany is an atomic conditional write
 * It does NOT prove Postgres behaviour — the real-DB harness (Phase 6) does.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const clone = (v) => (v == null ? v : structuredClone(v));

// Unique keys per table (single fields or composite arrays). null never conflicts.
const UNIQUES = {
  rewardPointsLedger: [['idempotencyKey']],
  rewardOrderAward:   [['affiliateOrderId'], ['orderId']],
  rewardRedemption:   [['reference'], ['affiliateId', 'clientRequestId']],
  rewardPointsAccount: [['affiliateId']],
  setting:            [['id']],
};
const PK = { rewardPointsAccount: 'affiliateId' };
const UPDATED_AT = new Set(['rewardGift', 'rewardPointsAccount', 'rewardOrderAward', 'rewardRedemption']);

export function makeRewardsFakeDb(seed = {}) {
  const T = {
    setting: [], affiliate: [], affiliateOrder: [], order: [],
    rewardPointsAccount: [], rewardPointsLedger: [], rewardOrderAward: [],
    rewardGift: [], rewardRedemption: [], rewardRedemptionHistory: [], rewardAuditLog: [],
    shippingCompany: [],
  };
  for (const [k, rows] of Object.entries(seed)) T[k] = rows.map((r) => ({ ...r }));
  let seq = 1;
  let txSeq = 0;
  const stats = { transactions: 0, rollbacks: 0, calls: {}, log: [], hooks: {} }; // calls['rewardGift.updateMany'] etc.

  // ── locks (rows touched by upsert in a tx; the affiliate_orders table) ──────
  const locks = new Map(); // key -> { owner, waiters: [] }
  async function acquire(ctx, key) {
    for (;;) {
      const l = locks.get(key);
      if (!l) { locks.set(key, { owner: ctx, waiters: [] }); ctx.held.add(key); return; }
      if (l.owner === ctx) return;
      await new Promise((res) => l.waiters.push(res));
    }
  }
  async function waitTableUnlocked(ctx, key) {
    for (;;) {
      const l = locks.get(key);
      if (!l || l.owner === ctx) return;
      await new Promise((res) => l.waiters.push(res));
    }
  }
  function releaseAll(ctx) {
    for (const key of ctx.held) {
      const l = locks.get(key);
      locks.delete(key);
      l?.waiters.forEach((w) => w());
    }
    ctx.held.clear();
  }

  // ── matching ────────────────────────────────────────────────────────────────
  const isOps = (v) => v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  function matchValue(actual, cond) {
    if (cond === null) return actual == null;
    if (!isOps(cond)) return val(actual) === val(cond);
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case 'in':     return v.map(val).includes(val(actual));
        case 'notIn':  return !v.map(val).includes(val(actual));
        case 'gt':     return actual != null && val(actual) > val(v);
        case 'gte':    return actual != null && val(actual) >= val(v);
        case 'lt':     return actual != null && val(actual) < val(v);
        case 'lte':    return actual != null && val(actual) <= val(v);
        case 'not':    return !matchValue(actual, v);
        case 'contains': return cond.mode === 'insensitive'
          ? String(actual ?? '').toLowerCase().includes(String(v).toLowerCase())
          : String(actual ?? '').includes(String(v));
        case 'equals': return cond.mode === 'insensitive'
          ? String(actual ?? '').toLowerCase() === String(v).toLowerCase()
          : val(actual) === val(v);
        case 'mode':   return true;
        default: throw new Error(`fake db: unsupported operator ${op}`);
      }
    });
  }
  function matches(table, row, where = {}) {
    return Object.entries(where).every(([k, cond]) => {
      if (k === 'OR') return cond.some((w) => matches(table, row, w));
      if (k === 'AND') return cond.every((w) => matches(table, row, w));
      if (table === 'affiliateOrder' && k === 'rewardAward') {
        const has = T.rewardOrderAward.some((a) => a.affiliateOrderId === row.id);
        if (cond === null) return !has;
        throw new Error('fake db: only rewardAward: null supported');
      }
      if (table === 'rewardOrderAward' && k === 'affiliateOrder') {
        const ao = T.affiliateOrder.find((o) => o.id === row.affiliateOrderId);
        return !!ao && matches('affiliateOrder', ao, cond);
      }
      return matchValue(row[k], cond);
    });
  }

  function applyData(row, data) {
    for (const [k, v] of Object.entries(data)) {
      if (isOps(v) && ('increment' in v || 'decrement' in v)) {
        row[k] = (row[k] ?? 0) + (v.increment ?? 0) - (v.decrement ?? 0);
      } else {
        row[k] = clone(v);
      }
    }
  }

  function uniqueConflict(table, row, ignore = null) {
    for (const fields of UNIQUES[table] || []) {
      if (fields.some((f) => row[f] == null)) continue;
      if (T[table].some((r) => r !== ignore && fields.every((f) => r[f] === row[f]))) return true;
    }
    return false;
  }
  // Every table with an affiliateId column references affiliates (RESTRICT).
  const fkReferences = (affiliateId) => Object.entries(T).some(([t, rows]) =>
    t !== 'affiliate' && rows.some((r) => r.affiliateId === affiliateId));
  const p2002 = (table) => Object.assign(new Error(`Unique constraint failed on ${table}`), { code: 'P2002' });

  function sortRows(rows, orderBy) {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0];
        const x = val(a[k]); const y = val(b[k]);
        if (x < y) return dir === 'desc' ? 1 : -1;
        if (x > y) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  }

  // ── model factory ───────────────────────────────────────────────────────────
  function model(table, ctx) {
    const undo = (fn) => { if (ctx) ctx.undo.push(fn); };
    const pk = PK[table] || 'id';
    const findIdx = (where) => T[table].findIndex((r) => matches(table, r, where));
    const gateWrite = () => (table === 'affiliateOrder' ? waitTableUnlocked(ctx, 'table:affiliate_orders') : null);
    const insert = (data) => {
      const row = { ...(pk === 'id' ? { id: `${table}_${seq++}` } : {}), createdAt: new Date(), ...clone(data) };
      if (UPDATED_AT.has(table)) row.updatedAt = new Date();
      if (uniqueConflict(table, row)) throw p2002(table);
      T[table].push(row);
      undo(() => { const i = T[table].indexOf(row); if (i >= 0) T[table].splice(i, 1); });
      return row;
    };
    // Rollback reverses counters by the inverse delta and restores plain fields
    // individually, so it never clobbers another transaction's counter change.
    const update = (row, data) => {
      const prev = Object.fromEntries(Object.keys(data).map((k) => [k, row[k]]));
      applyData(row, data);
      if (UPDATED_AT.has(table)) row.updatedAt = new Date();
      const revert = () => {
        for (const [k, v] of Object.entries(data)) {
          if (isOps(v) && ('increment' in v || 'decrement' in v)) row[k] -= (v.increment ?? 0) - (v.decrement ?? 0);
          else row[k] = prev[k];
        }
      };
      if (uniqueConflict(table, row, row)) { revert(); throw p2002(table); }
      undo(revert);
    };
    const api = {
      findUnique: async ({ where }) => clone(T[table][findIdx(where)] ?? null),
      findFirst:  async ({ where = {}, orderBy } = {}) => clone(sortRows(T[table].filter((r) => matches(table, r, where)), orderBy)[0] ?? null),
      findMany:   async ({ where = {}, orderBy, take, cursor, skip = 0 } = {}) => {
        let rows = sortRows(T[table].filter((r) => matches(table, r, where)), orderBy);
        if (cursor) { const i = rows.findIndex((r) => r.id === cursor.id); rows = rows.slice(i < 0 ? rows.length : i); }
        rows = rows.slice(skip);
        if (take != null) rows = rows.slice(0, take);
        return rows.map(clone);
      },
      count:      async ({ where = {} } = {}) => T[table].filter((r) => matches(table, r, where)).length,
      aggregate:  async ({ where = {}, _sum = {} }) => {
        const rows = T[table].filter((r) => matches(table, r, where));
        const sum = {};
        for (const f of Object.keys(_sum)) sum[f] = rows.length ? rows.reduce((s, r) => s + (r[f] ?? 0), 0) : null;
        return { _sum: sum };
      },
      groupBy:    async ({ by, where = {}, _sum = {}, _count }) => {
        const groups = new Map();
        for (const r of T[table].filter((x) => matches(table, x, where))) {
          const key = JSON.stringify(by.map((b) => r[b]));
          if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(by.map((b) => [b, r[b]])), _sum: Object.fromEntries(Object.keys(_sum).map((f) => [f, 0])), ...(_count ? { _count: { _all: 0 } } : {}) });
          const g = groups.get(key);
          for (const f of Object.keys(_sum)) g._sum[f] += r[f] ?? 0;
          if (_count) g._count._all += 1;
        }
        return [...groups.values()];
      },
      create:     async ({ data }) => { await gateWrite(); return clone(insert(data)); },
      createMany: async ({ data, skipDuplicates = false }) => {
        await gateWrite();
        let count = 0;
        for (const d of data) {
          try { insert(d); count++; } catch (e) { if (!(skipDuplicates && e.code === 'P2002')) throw e; }
        }
        return { count };
      },
      update:     async ({ where, data }) => {
        await gateWrite();
        const i = findIdx(where);
        if (i < 0) throw Object.assign(new Error(`${table} not found`), { code: 'P2025' });
        update(T[table][i], data);
        return clone(T[table][i]);
      },
      updateMany: async ({ where = {}, data }) => {
        await gateWrite();
        const rows = T[table].filter((r) => matches(table, r, where));
        rows.forEach((r) => update(r, data));
        return { count: rows.length };
      },
      upsert:     async ({ where, create, update: upd }) => {
        if (ctx) await acquire(ctx, `${table}:${JSON.stringify(where)}`);
        const i = findIdx(where);
        if (i >= 0) { update(T[table][i], upd); return clone(T[table][i]); }
        return clone(insert(create));
      },
      delete:     async ({ where }) => {
        const i = findIdx(where);
        if (i < 0) throw Object.assign(new Error(`${table} not found`), { code: 'P2025' });
        if (table === 'affiliate' && fkReferences(T[table][i].id)) {
          throw Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' });
        }
        const [row] = T[table].splice(i, 1);
        undo(() => T[table].push(row));
        return clone(row);
      },
      deleteMany: async ({ where = {} } = {}) => {
        const rows = T[table].filter((r) => matches(table, r, where));
        for (const row of rows) { T[table].splice(T[table].indexOf(row), 1); undo(() => T[table].push(row)); }
        return { count: rows.length };
      },
    };
    for (const [name, fn] of Object.entries(api)) {
      api[name] = async (...args) => {
        const k = `${table}.${name}`;
        stats.calls[k] = (stats.calls[k] || 0) + 1;
        stats.log.push({ call: k, tx: ctx?.id ?? null });
        if (stats.hooks[k]) await stats.hooks[k]({ ctx, args });
        return fn(...args);
      };
    }
    return api;
  }

  function client(ctx) {
    const c = { _tables: T, _stats: stats };
    for (const table of Object.keys(T)) c[table] = model(table, ctx);
    c.$executeRaw = async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      stats.log.push({ call: '$executeRaw', sql, values, tx: ctx?.id ?? null });
      if (/LOCK TABLE "affiliate_orders" IN SHARE MODE/.test(sql)) {
        if (!ctx) throw new Error('LOCK TABLE outside a transaction has no effect');
        if (stats.failTableLock) throw stats.failTableLock;   // e.g. lock_timeout
        if (!stats.disableTableLock) await acquire(ctx, 'table:affiliate_orders'); // negative control
      }
      return 0;
    };
    c.$queryRaw = async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      stats.log.push({ call: '$queryRaw', sql, values, tx: ctx?.id ?? null });
      if (/pg_try_advisory_xact_lock/.test(sql)) {
        if (!ctx) throw new Error('advisory xact lock outside a transaction is released at once');
        const key = `advisory:${values.join(':')}`;
        const l = locks.get(key);
        if (l && l.owner !== ctx) return [{ locked: false }];
        if (!l) { locks.set(key, { owner: ctx, waiters: [] }); ctx.held.add(key); }
        return [{ locked: true }];
      }
      throw new Error(`fake db: unsupported $queryRaw: ${sql}`);
    };
    c.$transaction = async (fn) => {
      if (ctx) return fn(c); // nested: join the outer transaction
      const tctx = { id: ++txSeq, undo: [], held: new Set() };
      stats.transactions++;
      try {
        const out = await fn(client(tctx));
        return out;
      } catch (e) {
        stats.rollbacks++;
        for (const u of tctx.undo.reverse()) u();
        throw e;
      } finally {
        stats.log.push({ call: '$commitOrRollback', tx: tctx.id });
        releaseAll(tctx);
      }
    };
    return c;
  }
  return client(null);
}
