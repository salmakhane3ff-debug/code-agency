#!/usr/bin/env node
/**
 * scripts/payment-proofs-publisher.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone PM2 worker that publishes scheduled Payment Proofs (the admin-managed
 * display feed of the affiliate-dashboard slider). Runs SEPARATE from the web
 * server, mirroring the existing engines (own process, own advisory lock, JSON
 * logs, graceful shutdown). Each tick publishes every due proof exactly once
 * (paymentProofPublisher.runPaymentProofPublishTick).
 *
 * STRICT ISOLATION: writes ONLY `payment_proofs` (status / publishedAt / failure
 * fields) and appends `payment_proof_events`. It never touches affiliates, users,
 * payouts, balances, commissions, rewards, deposits or orders.
 *
 * FLAGS:
 *   --once            run a single tick then exit
 *   --tick=<ms>       override the cadence (min 5000 ms; default 60000)
 *   --help
 *
 * SAFETY: with nothing scheduled, a tick is one cheap indexed query. A dedicated
 * session advisory lock (distinct key) guarantees only one runner works at a time;
 * every publication is additionally a conditional, transactional update.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import pg from 'pg';
import prisma from '../src/lib/prisma.js';
import {
  runPaymentProofPublishTick, PAYMENT_PROOF_PUBLISHER_LOCK_KEY, PAYMENT_PROOF_TICK_MS,
} from '../src/lib/services/paymentProofPublisher.js';
import { createPgAdvisoryLock } from '../src/lib/ugcAdvisoryLock.js';

const COMPONENT = 'payment-proofs-publisher';
const args = new Set(process.argv.slice(2));
const tickArg = process.argv.slice(2).find((a) => a.startsWith('--tick='));
const ONCE = args.has('--once');
const TICK_MS = Math.max(5000, Number(tickArg ? tickArg.split('=')[1] : NaN) || PAYMENT_PROOF_TICK_MS);

if (args.has('--help')) {
  console.log('Usage: node scripts/payment-proofs-publisher.mjs [--once] [--tick=<ms>]');
  process.exit(0);
}

const emit = (event, data = {}) => {
  try { console.log(JSON.stringify({ component: COMPONENT, ts: new Date().toISOString(), event, ...data })); }
  catch { /* logging must never throw */ }
};

// Dedicated advisory-lock connection (NOT the Prisma pool) — session-level.
const lock = createPgAdvisoryLock({
  key: PAYMENT_PROOF_PUBLISHER_LOCK_KEY,
  newClient: () => new pg.Client({ connectionString: process.env.DATABASE_URL }),
  onEvent: (event, data) => emit(event, data),
});

let stopping = false;
let timer = null;
let inFlight = Promise.resolve();

async function tick() {
  if (stopping) return;
  inFlight = runPaymentProofPublishTick({ lock }).then(
    (r) => emit('tick', r),
    (err) => emit('tick_crash', { error: String((err && err.message) || err) }),
  );
  await inFlight;
  if (ONCE || stopping) return shutdown('completed');
  timer = setTimeout(tick, TICK_MS);
}

let shuttingDownPromise = null;
async function shutdown(reason) {
  if (shuttingDownPromise) return shuttingDownPromise;
  stopping = true;
  if (timer) clearTimeout(timer);
  emit('shutdown', { reason });
  shuttingDownPromise = (async () => {
    try { await inFlight; } catch { /* already logged */ }
    try { await lock.end(); } catch { /* ignore */ }
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    emit('stopped', { reason });
    process.exit(0);
  })();
  return shuttingDownPromise;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  emit('boot', { once: ONCE, tickMs: TICK_MS });
  await tick();
})();
