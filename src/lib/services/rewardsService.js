/**
 * src/lib/services/rewardsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards points — config, ledger, order awards, signup bonus, admin
 * adjustments and reconciliation. Pure rules live in ../rewards.js; gift
 * requests live in ./rewardRedemptionService.js.
 *
 * SEPARATE FROM COMMISSIONS: this module never imports the balance provider
 * registry or affiliateSystemService and never writes affiliate money fields.
 * It only READS affiliate_orders / orders to decide whether an order earns.
 *
 * CONCURRENCY: every write path starts with lockAccount() — an upsert that
 * touches reward_points_accounts.version, so Postgres holds that row's lock
 * until the transaction ends. All point changes for one affiliate therefore run
 * one at a time (READ COMMITTED is enough; no Serializable retry needed). The
 * ledger's unique idempotencyKey and the award row's conditional state changes
 * are second and third lines of defence against double counting.
 *
 * IDEMPOTENCY: order points are recomputed from the order's CURRENT status, not
 * from events, so duplicate/out-of-order/retried calls are harmless.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  REWARDS_SETTING_ID, REWARDS_RECONCILE_STATE_ID, DELIVERED_STATUS, LEDGER_TYPE, EARNING_LEDGER_TYPES, ACTOR,
  AWARD_STATE, EXCLUSION_REASON, EDITABLE_CONFIG_KEYS,
  normalizeRewardsConfig, evaluateOrderEligibility, evaluateSignupBonusEligibility,
  validateAdjustment, isNonEmptyId, computeSpendable, holdUntil, ledgerKey,
} from '../rewards.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const BASELINE_BATCH = 1000;

// ── Config ────────────────────────────────────────────────────────────────────

/** Current config. A read failure yields the defaults (rewards OFF — fail closed). */
export async function getRewardsConfig(db = prisma) {
  const row = await db.setting.findUnique({ where: { id: REWARDS_SETTING_ID } }).catch(() => null);
  return normalizeRewardsConfig(row?.data);
}

/** How long enabling rewards waits for in-flight order writes before giving up. */
export const BASELINE_LOCK_TIMEOUT = '15s';

/**
 * Save admin-editable settings. Timestamps are system-managed:
 *   • enabled false→true  → enabledAt = now, launchedAt = now (first time only),
 *     and the LAUNCH BASELINE runs: every order delivered at this moment is
 *     recorded as EXCLUDED so it can never earn points (D11). Orders delivered
 *     while rewards were OFF are excluded the same way on re-enable.
 *   • signupBonusEnabled false→true → signupBonusEnabledAt = now (D2).
 * Every save writes a reward_audit_log row with before/after.
 *
 * RACE-FREE LAUNCH: one transaction, in this order —
 *   1. lock the settings row (upsert touch) and read the config UNDER the lock,
 *      so two admins saving at once are serialised (no lost update, no double
 *      baseline);
 *   2. when switching ON: `LOCK TABLE affiliate_orders IN SHARE MODE`. SHARE
 *      blocks every INSERT/UPDATE on affiliate_orders (reads still work) until
 *      this transaction commits. A status change that committed before the lock
 *      is seen by the baseline and EXCLUDED; one attempted after it waits, then
 *      lands once rewards are ON — a genuine post-launch delivery. No order can
 *      slip between the baseline snapshot and the switch;
 *   3. baseline, write config, audit — commit releases both locks.
 * lock_timeout bounds the wait: on timeout nothing changes and the admin gets
 * BASELINE_LOCK_TIMEOUT (retry). The lock is held only for the baseline.
 */
export async function saveRewardsConfig(input, { actorId = null, db = prisma, now = new Date() } = {}) {
  const patch = {};
  for (const key of EDITABLE_CONFIG_KEYS) {
    if (input && Object.prototype.hasOwnProperty.call(input, key)) patch[key] = input[key];
  }
  const at = new Date(now);
  const iso = at.toISOString();

  try {
    return await db.$transaction(async (tx) => {
      // 1. Serialise config saves on the settings row; read under the lock.
      const row = await tx.setting.upsert({
        where:  { id: REWARDS_SETTING_ID },
        create: { id: REWARDS_SETTING_ID, data: {} },
        update: { updatedAt: at },
      });
      const current = normalizeRewardsConfig(row?.data);
      const next = normalizeRewardsConfig({ ...current, ...patch });
      const turningOn = !current.enabled && next.enabled;
      if (turningOn) {
        next.enabledAt = iso;
        next.launchedAt = current.launchedAt || iso;
      }
      if (!current.signupBonusEnabled && next.signupBonusEnabled) next.signupBonusEnabledAt = iso;

      // 2–3. Freeze affiliate_orders writes, then snapshot what is delivered now.
      let baselineExcluded = 0;
      if (turningOn) {
        await tx.$executeRaw`SET LOCAL lock_timeout = '15s'`; // = BASELINE_LOCK_TIMEOUT
        await tx.$executeRaw`LOCK TABLE "affiliate_orders" IN SHARE MODE`;
        baselineExcluded = await recordLaunchBaseline(tx, at, {
          reason: current.launchedAt ? EXCLUSION_REASON.DISABLED_PERIOD : EXCLUSION_REASON.PRE_LAUNCH,
        });
      }

      await tx.setting.update({ where: { id: REWARDS_SETTING_ID }, data: { data: next } });
      await tx.rewardAuditLog.create({
        data: {
          action: 'CONFIG_UPDATE', entityType: 'rewards_config', entityId: REWARDS_SETTING_ID,
          actorType: ACTOR.ADMIN, actorId, before: current, after: next,
          reason: turningOn ? `enabled; ${baselineExcluded} delivered order(s) excluded by baseline` : null,
        },
      });
      return { config: next, baselineExcluded };
    }, { timeout: 120_000 });
  } catch (e) {
    if (isLockTimeout(e)) {
      throw err('BASELINE_LOCK_TIMEOUT', 'Commandes en cours de mise à jour — réessayez dans un instant');
    }
    throw e;
  }
}

/** Postgres lock_not_available (55P03), as surfaced by Prisma raw queries. */
function isLockTimeout(e) {
  return e?.meta?.code === '55P03' || e?.cause?.originalCode === '55P03' || /lock timeout/i.test(String(e?.message ?? ''));
}

/**
 * Baseline, run under the affiliate_orders SHARE lock:
 *   • every delivered order with no award row → EXCLUDED;
 *   • every REVERSED award whose order is delivered again → EXCLUDED (it was
 *     re-delivered while rewards were OFF, so it must not re-earn later).
 * AWARDED rows are untouched: those points were earned while rewards were ON.
 * Case-insensitive on purpose (an admin-typed 'Delivered' is excluded too):
 * over-excluding is the safe direction. skipDuplicates also absorbs a second
 * affiliate order pointing at an already-recorded store order.
 */
async function recordLaunchBaseline(tx, now, { reason }) {
  const deliveredNow = { equals: DELIVERED_STATUS, mode: 'insensitive' };
  const relocked = await tx.rewardOrderAward.updateMany({
    where: { state: AWARD_STATE.REVERSED, affiliateOrder: { status: deliveredNow } },
    data:  { state: AWARD_STATE.EXCLUDED, exclusionReason: reason },
  });
  let excluded = relocked.count;
  let lastId = null;
  for (;;) {
    const batch = await tx.affiliateOrder.findMany({
      where: {
        status: deliveredNow,
        rewardAward: null,
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      select:  { id: true, affiliateId: true, orderId: true },
      orderBy: { id: 'asc' },
      take:    BASELINE_BATCH,
    });
    if (batch.length === 0) break;
    const res = await tx.rewardOrderAward.createMany({
      data: batch.map((o) => ({
        affiliateOrderId: o.id,
        orderId:          o.orderId || null,
        affiliateId:      o.affiliateId,
        points:           0,
        state:            AWARD_STATE.EXCLUDED,
        exclusionReason:  reason,
        version:          1,
        createdAt:        now,
      })),
      skipDuplicates: true,
    });
    excluded += res.count;
    lastId = batch[batch.length - 1].id;
    if (batch.length < BASELINE_BATCH) break;
  }
  return excluded;
}

// ── Ledger primitives (call inside a transaction) ─────────────────────────────

/** Create-or-touch the affiliate's account row: takes its row lock until commit. */
export async function lockAccount(tx, affiliateId) {
  return tx.rewardPointsAccount.upsert({
    where:  { affiliateId },
    create: { affiliateId },
    update: { version: { increment: 1 } },
  });
}

/**
 * Append one ledger row and move the running total by the same delta.
 * The caller MUST already hold lockAccount() for this affiliate.
 */
export async function appendLedger(tx, {
  affiliateId, delta, type, sourceType, sourceId = null, idempotencyKey,
  reason = null, actorType = ACTOR.SYSTEM, actorId = null, metadata = null,
}) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw err('INVALID_DELTA', 'Variation de points invalide');
  const account = await tx.rewardPointsAccount.update({
    where: { affiliateId },
    data:  { balance: { increment: delta } },
  });
  return tx.rewardPointsLedger.create({
    data: {
      affiliateId, delta, type, sourceType, sourceId, idempotencyKey,
      reason, actorType, actorId, balanceAfter: account.balance,
      ...(metadata != null ? { metadata } : {}), // omitted → column stays NULL
    },
  });
}

/** Points from AWARDED orders still inside their hold period (D4). */
export async function getHeldPoints(db, affiliateId, now = new Date()) {
  const r = await db.rewardOrderAward.aggregate({
    where: { affiliateId, state: AWARD_STATE.AWARDED, availableAt: { gt: new Date(now) } },
    _sum:  { points: true },
  });
  return r._sum.points ?? 0;
}

// ── Order points ──────────────────────────────────────────────────────────────

/**
 * Bring one affiliate order's points in line with its CURRENT status.
 *
 *   no award row  + delivered + eligible   → AWARD (snapshot points, v1)
 *   AWARDED       + no longer delivered    → REVERSE (always, even if rewards are OFF)
 *   REVERSED      + delivered again        → RE-AWARD with the SAME points (D9), v+1
 *   EXCLUDED (pre-launch baseline)         → never awarded (D11)
 *
 * Eligibility (D1 suspicious, fake, unlinked…) is checked when awarding only;
 * a reversal is triggered solely by the order leaving 'delivered'.
 * Safe to call any number of times, concurrently, from any code path.
 *
 * Status-change hooks MUST use the default (precheck: false): every call takes
 * the affiliate's account lock and only then reads the status and award state.
 * That lock is what serialises "award in flight" against "order cancelled": the
 * cancel's call waits for the award to commit, then sees it and reverses it.
 * `precheck: true` (reconcile only) first does a lock-free read and skips the
 * transaction when nothing looks needed. A stale read can skip needed work, so
 * it is only acceptable where a later pass re-checks the same order.
 *
 * @returns {Promise<{action: 'awarded'|'reversed'|'reawarded'|'noop', reason?: string, points?: number}>}
 */
export async function syncOrderRewards(affiliateOrderId, { db = prisma, now = new Date(), precheck = false } = {}) {
  if (!isNonEmptyId(affiliateOrderId)) return { action: 'noop', reason: 'INVALID_ID' };
  const config = await getRewardsConfig(db);
  let head;
  if (precheck) {
    const pre = await precheckOrderSync(db, affiliateOrderId, config);
    if (!pre.needed) return { action: 'noop', reason: pre.reason };
    head = pre.affiliateOrder;
  } else {
    head = await db.affiliateOrder.findUnique({ where: { id: affiliateOrderId }, select: { id: true, affiliateId: true } });
    if (!head) return { action: 'noop', reason: 'NOT_FOUND' };
  }
  const at = new Date(now);

  return db.$transaction(async (tx) => {
    await lockAccount(tx, head.affiliateId);

    // Re-read under the lock: the status may have moved since `head`.
    const ao = await tx.affiliateOrder.findUnique({
      where:  { id: affiliateOrderId },
      select: { id: true, affiliateId: true, orderId: true, status: true, isFake: true, isSuspicious: true },
    });
    if (!ao) return { action: 'noop', reason: 'NOT_FOUND' };
    const delivered = ao.status === DELIVERED_STATUS;
    const award = await tx.rewardOrderAward.findUnique({ where: { affiliateOrderId } });

    if (award?.state === AWARD_STATE.EXCLUDED) return { action: 'noop', reason: 'PRE_LAUNCH' };

    if (award?.state === AWARD_STATE.AWARDED) {
      if (delivered) return { action: 'noop', reason: 'ALREADY_AWARDED' };
      const moved = await tx.rewardOrderAward.updateMany({
        where: { id: award.id, state: AWARD_STATE.AWARDED, version: award.version },
        data:  { state: AWARD_STATE.REVERSED, reversedAt: at },
      });
      if (moved.count !== 1) return { action: 'noop', reason: 'CONCURRENT_UPDATE' };
      await appendLedger(tx, {
        affiliateId: award.affiliateId, delta: -award.points, type: LEDGER_TYPE.ORDER_REVERSAL,
        sourceType: 'affiliate_order', sourceId: ao.id,
        idempotencyKey: ledgerKey.orderReversal(ao.id, award.version),
        reason: `Order status is now '${ao.status}'`, metadata: { orderId: ao.orderId, status: ao.status },
      });
      return { action: 'reversed', points: award.points };
    }

    if (!delivered) return { action: 'noop', reason: 'NOT_DELIVERED' };

    const order = ao.orderId
      ? await tx.order.findUnique({ where: { id: ao.orderId }, select: { id: true, isFake: true, affiliateId: true } })
      : null;

    if (award?.state === AWARD_STATE.REVERSED) {
      const elig = evaluateOrderEligibility({ affiliateOrder: ao, order, config }, { requireConfiguredPoints: false });
      if (!elig.eligible) return { action: 'noop', reason: elig.reason };
      const version = award.version + 1;
      const moved = await tx.rewardOrderAward.updateMany({
        where: { id: award.id, state: AWARD_STATE.REVERSED, version: award.version },
        data:  { state: AWARD_STATE.AWARDED, version, awardedAt: at, availableAt: holdUntil(at, config.orderPointsHoldDays) },
      });
      if (moved.count !== 1) return { action: 'noop', reason: 'CONCURRENT_UPDATE' };
      await appendLedger(tx, {
        affiliateId: award.affiliateId, delta: award.points, type: LEDGER_TYPE.ORDER_DELIVERED,
        sourceType: 'affiliate_order', sourceId: ao.id,
        idempotencyKey: ledgerKey.orderAward(ao.id, version),
        reason: 'Order delivered again (original points snapshot)', metadata: { orderId: ao.orderId, reaward: true },
      });
      return { action: 'reawarded', points: award.points };
    }

    // No award row yet → first award.
    const elig = evaluateOrderEligibility({ affiliateOrder: ao, order, config });
    if (!elig.eligible) return { action: 'noop', reason: elig.reason };
    const points = config.pointsPerDeliveredOrder;
    const created = await tx.rewardOrderAward.createMany({
      data: [{
        affiliateOrderId: ao.id, orderId: ao.orderId, affiliateId: ao.affiliateId, points,
        state: AWARD_STATE.AWARDED, version: 1, awardedAt: at,
        availableAt: holdUntil(at, config.orderPointsHoldDays), createdAt: at,
      }],
      // ON CONFLICT DO NOTHING: another affiliate order already earned for this
      // store order (orderId unique) — and the transaction is NOT aborted.
      skipDuplicates: true,
    });
    if (created.count !== 1) return { action: 'noop', reason: 'DUPLICATE_ORDER' };
    await appendLedger(tx, {
      affiliateId: ao.affiliateId, delta: points, type: LEDGER_TYPE.ORDER_DELIVERED,
      sourceType: 'affiliate_order', sourceId: ao.id,
      idempotencyKey: ledgerKey.orderAward(ao.id, 1),
      reason: 'Order delivered', metadata: { orderId: ao.orderId },
    });
    return { action: 'awarded', points };
  });
}

/**
 * Lock-free decision (reconcile only — see syncOrderRewards): could this
 * order's CURRENT state change any points?
 *   AWARDED + not delivered          → yes (reversal)
 *   no row  + delivered + eligible   → yes (award)
 *   REVERSED + delivered + eligible  → yes (re-award, snapshot points)
 *   anything else                    → no (same noop reason the locked path gives)
 */
async function precheckOrderSync(db, affiliateOrderId, config) {
  const [ao, award] = await Promise.all([
    db.affiliateOrder.findUnique({
      where:  { id: affiliateOrderId },
      select: { id: true, affiliateId: true, orderId: true, status: true, isFake: true, isSuspicious: true },
    }),
    db.rewardOrderAward.findUnique({ where: { affiliateOrderId }, select: { state: true } }),
  ]);
  if (!ao) return { needed: false, reason: 'NOT_FOUND' };
  const delivered = ao.status === DELIVERED_STATUS;
  if (award?.state === AWARD_STATE.EXCLUDED) return { needed: false, reason: 'PRE_LAUNCH' };
  if (award?.state === AWARD_STATE.AWARDED) {
    return delivered ? { needed: false, reason: 'ALREADY_AWARDED' } : { needed: true, affiliateOrder: ao };
  }
  if (!delivered) return { needed: false, reason: 'NOT_DELIVERED' };
  const order = ao.orderId
    ? await db.order.findUnique({ where: { id: ao.orderId }, select: { id: true, isFake: true, affiliateId: true } })
    : null;
  const elig = evaluateOrderEligibility(
    { affiliateOrder: ao, order, config },
    { requireConfiguredPoints: award?.state !== AWARD_STATE.REVERSED },
  );
  return elig.eligible ? { needed: true, affiliateOrder: ao } : { needed: false, reason: elig.reason };
}

/** Default cap on order visits per reconcile call (keeps one HTTP request bounded). */
export const RECONCILE_MAX_PER_RUN = 1000;
/** Share of the cap kept for awards/re-awards while reversals are pending (rewards ON). */
const RECONCILE_ORDERS_RESERVE = 0.1;
/** Advisory lock (two int4 keys: 'RWDS', 1) held by the one reconcile allowed to run. */
const RECONCILE_LOCK_KEYS = [0x52574453, 1];
/** Lifetime of the guard transaction that holds the lock; the scan stops a minute before. */
export const RECONCILE_LOCK_TTL_MS = 10 * 60_000;

/**
 * Award/re-award share of a `total` budget: none when rewards are OFF (track B
 * does not run) or when the budget is a single visit (reversals first); else
 * 10%, but at least 1. Always < total, so reversals keep at least one visit.
 */
export function reconcileOrdersReserve(total, enabled) {
  if (!enabled || total < 2) return 0;
  return Math.max(1, Math.floor(total * RECONCILE_ORDERS_RESERVE));
}

const isCursor = (c) => c && typeof c === 'object' && typeof c.phase === 'string' && isNonEmptyId(c.id);

/**
 * Safety net for missed hooks: re-sync every order whose award state disagrees
 * with its status. Idempotent — re-running never applies anything twice.
 *
 * Two tracks, in this order:
 *   A. reversals — AWARDED but no longer delivered. Always runs, even with
 *      rewards OFF, and goes first.
 *   B. awards, then re-awards — delivered with no award row (only orders that
 *      CAN earn: not fake, linked, D1), and REVERSED but delivered again.
 *      Only when rewards are ON. Uses the lock-free pre-check, so orders that
 *      still cannot earn cost reads only.
 *
 * Bounded and starvation-free:
 *   • at most `maxPerRun` order visits per call (invalid / non-positive →
 *     1,000); every visit counts, eligible or not. Track A may use all of it
 *     except the reserve kept for track B when ON (10%, at least 1 when the
 *     budget is 2 or more), so a reversal backlog cannot block awards for ever.
 *   • each track is a CIRCULAR scan in id order that resumes after the last
 *     order the previous call visited (cursors in the 'rewards-reconcile-state'
 *     settings row) and wraps to the start. Rows already visited are not
 *     re-read until every other candidate has had its turn, so however many
 *     never-eligible orders sort first, every candidate is visited within
 *     ceil(candidates / budget) + 1 consecutive calls.
 *   • `truncated: true` means this call left at least one candidate unvisited —
 *     call again (each call continues where the last stopped). It stays true
 *     while a track has more candidates than the budget, even if they are all
 *     ineligible; progress is still guaranteed by the cursors.
 *
 * ONE RUN AT A TIME: the whole call runs inside a "guard" transaction holding
 * pg_try_advisory_xact_lock. A call that cannot take it fails at once with
 * RECONCILE_IN_PROGRESS (HTTP 409) — no order visited, cursors untouched. The
 * cursors are read and saved inside the guard, so they commit with it; the
 * per-order syncs keep their own short transactions (outside the guard). The
 * lock is released by Postgres when the guard commits or rolls back (error,
 * timeout, lost connection). The scan stops one minute before the guard's
 * timeout, so the lock can never expire under a running scan.
 */
export async function reconcileOrderRewards({
  db = prisma, now = new Date(), batchSize = 200, maxPerRun = RECONCILE_MAX_PER_RUN,
  timeLimitMs = RECONCILE_LOCK_TTL_MS - 60_000,
} = {}) {
  return db.$transaction(async (guard) => {
    const [row] = await guard.$queryRaw`SELECT pg_try_advisory_xact_lock(${RECONCILE_LOCK_KEYS[0]}::int, ${RECONCILE_LOCK_KEYS[1]}::int) AS locked`;
    if (row?.locked !== true) {
      throw err('RECONCILE_IN_PROGRESS', 'Une réconciliation est déjà en cours. Réessayez dans quelques minutes.');
    }
    return runReconcile({ db, guard, now, batchSize, maxPerRun, deadline: Date.now() + timeLimitMs });
  }, { maxWait: 10_000, timeout: RECONCILE_LOCK_TTL_MS });
}

async function runReconcile({ db, guard, now, batchSize, maxPerRun, deadline }) {
  const totals = { awarded: 0, reversed: 0, reawarded: 0, noop: 0, errors: 0, truncated: false };
  const config = await getRewardsConfig(db);
  const total = Number.isSafeInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : RECONCILE_MAX_PER_RUN;
  const reserve = reconcileOrdersReserve(total, config.enabled);
  let budget = total - reserve;

  const stateRow = await guard.setting.findUnique({ where: { id: REWARDS_RECONCILE_STATE_ID } }).catch(() => null);
  const saved = stateRow?.data && typeof stateRow.data === 'object' ? stateRow.data : {};
  const state = { reversals: isCursor(saved.reversals) ? saved.reversals : null, orders: isCursor(saved.orders) ? saved.orders : null };

  const visit = async (id, precheck) => {
    try {
      const r = await syncOrderRewards(id, { db, now, precheck });
      totals[r.action] += 1;
    } catch (e) {
      totals.errors += 1;
      console.error('[rewards] reconcile failed for', id, e?.message ?? e);
    }
  };

  /**
   * One circular pass over `phases` (each: { key, fetch({ gt, lte }) → ids in
   * id order }), starting just after `cursor` and wrapping round to it.
   * @returns {{ complete: boolean, cursor: object|null }} cursor = last visited
   *          order, or null once the whole circle was visited.
   */
  const circularScan = async (phases, cursor, precheck) => {
    const ci = isCursor(cursor) ? phases.findIndex((p) => p.key === cursor.phase) : -1;
    const segments = ci < 0
      ? phases.map((p) => ({ p }))
      : [
          { p: phases[ci], gt: cursor.id },
          ...phases.slice(ci + 1).map((p) => ({ p })),
          ...phases.slice(0, ci).map((p) => ({ p })),
          { p: phases[ci], lte: cursor.id },
        ];
    let last = ci < 0 ? null : cursor;
    for (const { p, gt, lte } of segments) {
      let after = gt ?? null;
      for (;;) {
        const ids = await p.fetch({ gt: after, lte: lte ?? null });
        for (const id of ids) {
          if (budget <= 0 || Date.now() >= deadline) return { complete: false, cursor: last };
          budget -= 1;
          await visit(id, precheck);
          last = { phase: p.key, id };
        }
        if (ids.length < batchSize) break;
        after = ids[ids.length - 1];
      }
    }
    return { complete: true, cursor: null };
  };
  const idRange = ({ gt, lte }) => (gt || lte ? { ...(gt ? { gt } : {}), ...(lte ? { lte } : {}) } : undefined);
  const awardsByOrder = (awardState, status) => async (range) => (await db.rewardOrderAward.findMany({
    where: { state: awardState, affiliateOrder: { status }, ...(idRange(range) ? { affiliateOrderId: idRange(range) } : {}) },
    select: { affiliateOrderId: true }, orderBy: { affiliateOrderId: 'asc' }, take: batchSize,
  })).map((a) => a.affiliateOrderId);

  // A. Missed reversals first (no pre-check: every candidate needs the lock).
  const a = await circularScan([
    { key: 'reversals', fetch: awardsByOrder(AWARD_STATE.AWARDED, { not: DELIVERED_STATUS }) },
  ], state.reversals, false);
  state.reversals = a.cursor;
  totals.truncated = !a.complete;

  if (config.enabled) {
    budget += reserve;
    // B. Missed awards, then missed re-awards, as one circle.
    const b = await circularScan([
      { key: 'awards', fetch: async (range) => (await db.affiliateOrder.findMany({
        where: {
          status: DELIVERED_STATUS, rewardAward: null, isFake: false, orderId: { not: null },
          ...(config.excludeSuspicious ? { isSuspicious: false } : {}),
          ...(idRange(range) ? { id: idRange(range) } : {}),
        },
        select: { id: true }, orderBy: { id: 'asc' }, take: batchSize,
      })).map((o) => o.id) },
      { key: 'reawards', fetch: awardsByOrder(AWARD_STATE.REVERSED, DELIVERED_STATUS) },
    ], state.orders, true);
    state.orders = b.cursor;
    totals.truncated = totals.truncated || !b.complete;
  }

  if (JSON.stringify(state) !== JSON.stringify({ reversals: saved.reversals ?? null, orders: saved.orders ?? null })) {
    await guard.setting.upsert({
      where: { id: REWARDS_RECONCILE_STATE_ID },
      create: { id: REWARDS_RECONCILE_STATE_ID, data: state },
      update: { data: state },
    });
  }
  return totals;
}

// ── Signup bonus ──────────────────────────────────────────────────────────────

/** Award the signup bonus once (ledger key `signup:{id}`); a no-op if ineligible. */
export async function awardSignupBonus(affiliateId, { db = prisma } = {}) {
  if (!isNonEmptyId(affiliateId)) return { awarded: false, reason: 'INVALID_ID' };
  const config = await getRewardsConfig(db);
  const affiliate = await db.affiliate.findUnique({
    where: { id: affiliateId }, select: { id: true, isActive: true, createdAt: true },
  });
  const elig = evaluateSignupBonusEligibility({ affiliate, config });
  if (!elig.eligible) return { awarded: false, reason: elig.reason };

  return db.$transaction(async (tx) => {
    await lockAccount(tx, affiliateId);
    const key = ledgerKey.signup(affiliateId);
    if (await tx.rewardPointsLedger.findUnique({ where: { idempotencyKey: key } })) {
      return { awarded: false, reason: 'ALREADY_AWARDED' };
    }
    const entry = await appendLedger(tx, {
      affiliateId, delta: config.signupBonusPoints, type: LEDGER_TYPE.SIGNUP_BONUS,
      sourceType: 'affiliate', sourceId: affiliateId, idempotencyKey: key, reason: 'Signup bonus',
    });
    return { awarded: true, entry };
  });
}

// ── Signup bonus on activation (Phase 3) ──────────────────────────────────────
// "Only on the FIRST admin activation": the first activation that reaches a
// definitive outcome (awarded, or not eligible) is recorded as an append-only
// reward_audit_log row (SIGNUP_BONUS_DECISION). Later activations see it and
// do nothing — so an affiliate first activated while the bonus was off can
// never collect it by being deactivated and reactivated. A transient failure
// records nothing, so the next activation or reconcileSignupBonuses retries.

const SIGNUP_DECISION = 'SIGNUP_BONUS_DECISION';
/** Outcomes that are NOT final for the "first activation" rule. */
const NON_FINAL_SIGNUP_REASONS = new Set(['INVALID_ID', 'AFFILIATE_NOT_FOUND', 'AFFILIATE_INACTIVE']);

async function hasSignupDecision(db, affiliateId) {
  return (await db.rewardAuditLog.count({ where: { action: SIGNUP_DECISION, entityType: 'affiliate', entityId: affiliateId } })) > 0;
}

/**
 * Called after an admin switched an affiliate from inactive to active.
 * @returns {Promise<{awarded: boolean, reason?: string}>}
 */
export async function awardSignupBonusOnActivation(affiliateId, { db = prisma } = {}) {
  if (!isNonEmptyId(affiliateId)) return { awarded: false, reason: 'INVALID_ID' };
  if (await hasSignupDecision(db, affiliateId)) return { awarded: false, reason: 'ALREADY_DECIDED' };
  const result = await awardSignupBonus(affiliateId, { db }); // throws on transient errors → no decision row
  if (!NON_FINAL_SIGNUP_REASONS.has(result.reason)) {
    await db.rewardAuditLog.create({
      data: {
        action: SIGNUP_DECISION, entityType: 'affiliate', entityId: affiliateId, actorType: ACTOR.SYSTEM,
        after: { awarded: result.awarded, reason: result.reason ?? null },
      },
    });
  }
  return { awarded: result.awarded, ...(result.reason ? { reason: result.reason } : {}) };
}

/**
 * Safety net for activations whose hook failed: active affiliates created
 * after the bonus went live, with neither a bonus nor a recorded decision.
 */
export async function reconcileSignupBonuses({ db = prisma, batchSize = 200 } = {}) {
  const totals = { awarded: 0, skipped: 0, errors: 0 };
  const config = await getRewardsConfig(db);
  if (!config.enabled || !config.signupBonusEnabled || !(config.signupBonusPoints > 0)
    || !config.launchedAt || !config.signupBonusEnabledAt) return totals;
  const since = new Date(Math.max(new Date(config.launchedAt).getTime(), new Date(config.signupBonusEnabledAt).getTime()));
  let lastId = null;
  for (;;) {
    const batch = await db.affiliate.findMany({
      where: { isActive: true, createdAt: { gte: since }, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true }, orderBy: { id: 'asc' }, take: batchSize,
    });
    for (const { id } of batch) {
      try {
        const done = await db.rewardPointsLedger.findUnique({ where: { idempotencyKey: ledgerKey.signup(id) } });
        if (done || await hasSignupDecision(db, id)) { totals.skipped += 1; continue; }
        const r = await awardSignupBonusOnActivation(id, { db });
        totals[r.awarded ? 'awarded' : 'skipped'] += 1;
      } catch (e) {
        totals.errors += 1;
        console.error('[rewards] signup reconcile failed for', id, e?.message ?? e);
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1].id;
  }
  return totals;
}

// ── Admin adjustments ─────────────────────────────────────────────────────────

/**
 * Manual +/- points with a mandatory reason, recorded with the admin's id.
 * Idempotent per (affiliate, clientRequestId). A debit may never take the
 * balance below zero (D3: only order reversals can create a points debt).
 */
export async function adjustPoints({ affiliateId, delta, reason, clientRequestId, actorId }, { db = prisma } = {}) {
  if (!isNonEmptyId(affiliateId)) throw err('INVALID_INPUT', 'Affilié invalide', { errors: { affiliateId: 'INVALID_ID' } });
  if (!isNonEmptyId(actorId)) throw err('INVALID_INPUT', 'Administrateur requis', { errors: { actorId: 'REQUIRED' } });
  const v = validateAdjustment({ delta, reason, clientRequestId });
  if (!v.ok) throw err('INVALID_INPUT', 'Ajustement invalide', { errors: v.errors });

  const exists = await db.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true } });
  if (!exists) throw err('AFFILIATE_NOT_FOUND', 'Affilié introuvable');

  return db.$transaction(async (tx) => {
    const account = await lockAccount(tx, affiliateId);
    const key = ledgerKey.adjustment(affiliateId, v.value.clientRequestId);
    const prior = await tx.rewardPointsLedger.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.delta !== v.value.delta) throw err('IDEMPOTENCY_CONFLICT', 'Requête déjà utilisée avec une autre valeur');
      return { entry: prior, duplicate: true };
    }
    if (v.value.delta < 0 && account.balance + v.value.delta < 0) {
      throw err('INSUFFICIENT_POINTS', 'Le solde de points ne peut pas devenir négatif');
    }
    const entry = await appendLedger(tx, {
      affiliateId, delta: v.value.delta, type: LEDGER_TYPE.ADMIN_ADJUSTMENT,
      sourceType: 'admin', sourceId: actorId, idempotencyKey: key,
      reason: v.value.reason, actorType: ACTOR.ADMIN, actorId,
    });
    return { entry, duplicate: false };
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Points overview for one affiliate. balance is the ledger running total;
 * debt > 0 only after a reversal of already-spent points (D3).
 */
export async function getPointsSummary(affiliateId, { db = prisma, now = new Date() } = {}) {
  const [account, held, groups] = await Promise.all([
    db.rewardPointsAccount.findUnique({ where: { affiliateId } }),
    getHeldPoints(db, affiliateId, now),
    db.rewardPointsLedger.groupBy({ by: ['type'], where: { affiliateId }, _sum: { delta: true } }),
  ]);
  const byType = Object.fromEntries(groups.map((g) => [g.type, g._sum.delta ?? 0]));
  const balance = account?.balance ?? 0;
  return {
    balance,
    held,
    spendable:     computeSpendable(balance, held),
    debt:          balance < 0 ? -balance : 0,
    totalEarned:   EARNING_LEDGER_TYPES.reduce((s, t) => s + (byType[t] ?? 0), 0),
    totalRedeemed: -((byType[LEDGER_TYPE.REDEMPTION_DEBIT] ?? 0) + (byType[LEDGER_TYPE.REDEMPTION_REFUND] ?? 0)),
  };
}

/** Newest-first ledger page for one affiliate (cursor = last entry id). */
export async function listLedger(affiliateId, { db = prisma, cursor = null, take = 50 } = {}) {
  const size = Math.min(Math.max(Number.isSafeInteger(take) ? take : 50, 1), 200);
  const rows = await db.rewardPointsLedger.findMany({
    where:   { affiliateId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take:    size + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > size;
  const items = hasMore ? rows.slice(0, size) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/** Audit check: the running total must equal the sum of the ledger. */
export async function verifyAccountBalance(affiliateId, { db = prisma } = {}) {
  const [account, sum] = await Promise.all([
    db.rewardPointsAccount.findUnique({ where: { affiliateId } }),
    db.rewardPointsLedger.aggregate({ where: { affiliateId }, _sum: { delta: true } }),
  ]);
  const balance = account?.balance ?? 0;
  const ledgerSum = sum._sum.delta ?? 0;
  return { ok: balance === ledgerSum, balance, ledgerSum };
}

// ── Admin reads: accounts & audit ─────────────────────────────────────────────

/**
 * Affiliates with their points balance (0 when no account yet), so an admin
 * can find anyone — including before their first points.
 */
export async function adminListAccounts({ q = '', take = 50, db = prisma } = {}) {
  const size = Math.min(Math.max(Number.isSafeInteger(take) ? take : 50, 1), 200);
  const term = typeof q === 'string' ? q.trim().slice(0, 100) : '';
  const affiliates = await db.affiliate.findMany({
    where: term ? { OR: [{ username: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] } : {},
    select: { id: true, username: true, name: true, isActive: true },
    orderBy: { createdAt: 'desc' },
    take: size,
  });
  const ids = affiliates.map((a) => a.id);
  const accounts = ids.length ? await db.rewardPointsAccount.findMany({ where: { affiliateId: { in: ids } } }) : [];
  const balanceBy = Object.fromEntries(accounts.map((a) => [a.affiliateId, a.balance]));
  return affiliates.map((a) => ({ ...a, balance: balanceBy[a.id] ?? 0 }));
}

/** Everything about one affiliate's points: summary, ledger page, awards, requests. */
export async function adminGetAccount(affiliateId, { db = prisma, now = new Date(), cursor = null } = {}) {
  if (!isNonEmptyId(affiliateId)) throw err('AFFILIATE_NOT_FOUND', 'Affilié introuvable');
  const affiliate = await db.affiliate.findUnique({
    where: { id: affiliateId }, select: { id: true, username: true, name: true, isActive: true, createdAt: true },
  });
  if (!affiliate) throw err('AFFILIATE_NOT_FOUND', 'Affilié introuvable');
  const [summary, ledger, awards, redemptions, check] = await Promise.all([
    getPointsSummary(affiliateId, { db, now }),
    listLedger(affiliateId, { db, cursor, take: 50 }),
    db.rewardOrderAward.findMany({ where: { affiliateId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.rewardRedemption.findMany({ where: { affiliateId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    verifyAccountBalance(affiliateId, { db }),
  ]);
  return { affiliate, summary, ledger, awards, redemptions, booksBalanced: check.ok };
}

/** Newest-first audit log page (config, gifts, stock, fulfilment). */
export async function listRewardAudit({ entityType = null, cursor = null, take = 50, db = prisma } = {}) {
  const size = Math.min(Math.max(Number.isSafeInteger(take) ? take : 50, 1), 200);
  const rows = await db.rewardAuditLog.findMany({
    where: typeof entityType === 'string' && entityType ? { entityType } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: size + 1,
    ...(isNonEmptyId(cursor) ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > size;
  const items = hasMore ? rows.slice(0, size) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
