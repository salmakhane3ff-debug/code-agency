#!/usr/bin/env node
/**
 * scripts/demo-leaderboard-engine.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone runner of the Demo Competition (Top Members / Top Brands) engine.
 * Runs as its own PM2 process, separate from the web server (same pattern as the
 * other engines). Each tick generates, for every demo member and demo brand, the
 * missing daily plans and the demo sale events whose scheduled time has passed
 * (demoCompetitionService.runEngine) — deterministic and idempotent (unique
 * idempotency keys + per-profile transaction locks), so a restart, a delay or a
 * concurrent page-visit catch-up never loses or duplicates an event.
 *
 * SIMULATION ONLY — writes demo_comp_* tables exclusively (plans, events, the
 * per-profile cursors, the engine's last-run row). Never an order, commission,
 * payout, wallet, deposit, booster, UGC or reward row.
 *
 * It is a no-op until an admin switches the engine ON (Admin → Demo Competition →
 * Live Engine). The OLD demo generator (demo-competition-engine) is a different
 * process and system; this one never touches its demo_* tables.
 *
 * FLAGS: --once | --tick=<ms> (min 5000, default 15000) | --help
 * ─────────────────────────────────────────────────────────────────────────────
 */

import pg from 'pg';
import prisma from '../src/lib/prisma.js';
import { runDemoCompTick, DEMO_COMP_ENGINE_LOCK_KEY } from '../src/lib/services/demoCompetitionService.js';
import { createPgAdvisoryLock } from '../src/lib/ugcAdvisoryLock.js';

const COMPONENT = 'demo-leaderboard-engine';
const args = new Set(process.argv.slice(2));
const tickArg = process.argv.slice(2).find((a) => a.startsWith('--tick='));
const ONCE = args.has('--once');
const TICK_MS = Math.max(5000, Number(tickArg ? tickArg.split('=')[1] : NaN) || 15_000);

if (args.has('--help')) {
  console.log('Usage: node scripts/demo-leaderboard-engine.mjs [--once] [--tick=<ms>]');
  process.exit(0);
}

const emit = (event, data = {}) => {
  try { console.log(JSON.stringify({ component: COMPONENT, ts: new Date().toISOString(), event, ...data })); }
  catch { /* logging must never throw */ }
};

// Dedicated session advisory-lock connection (NOT the Prisma pool): two runners never tick together.
const lock = createPgAdvisoryLock({
  key: DEMO_COMP_ENGINE_LOCK_KEY,
  newClient: () => new pg.Client({ connectionString: process.env.DATABASE_URL }),
  onEvent: (event, data) => emit(event, data),
});

let stopping = false;
let timer = null;
let inFlight = Promise.resolve();

async function tick() {
  if (stopping) return;
  inFlight = runDemoCompTick({ lock }).then(
    (r) => emit('tick', { events: r.events ?? 0, profiles: r.profiles ?? 0, skipped: r.skipped || null, error: r.error || null }),
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
