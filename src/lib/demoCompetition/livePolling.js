/**
 * src/lib/demoCompetition/livePolling.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure live-polling scheduler + leaderboard diff for the public Demo Competition
 * pages (no React, no DOM access: timers, fetch and AbortController are
 * injectable so scripts/demoCompetitionPublic.test.mjs drives it with fakes).
 *
 * Rules
 *   • self-scheduling setTimeout (never setInterval): the next poll is scheduled
 *     only AFTER the current request settled → requests never overlap;
 *   • in-flight guard: a refresh / resume while a request runs does nothing;
 *   • paused while the document is hidden or the observed element is off-screen
 *     (no timer pending); becoming visible again refetches immediately;
 *   • stop() aborts the running request and never calls back afterwards;
 *   • errors keep the last good data (the caller only receives onError).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const POLL_INTERVAL_MS = 5000;
export const HIGHLIGHT_MS = 1500;

/** True for the rejection of an aborted fetch. */
export const isAbortError = (e) => !!e && (e.name === "AbortError" || e.code === 20);

/** fetch → JSON with `cache: "no-store"`; non-2xx throws an Error carrying `status`. */
export function createJsonFetcher(url, fetchImpl) {
  return async (signal) => {
    const f = fetchImpl ?? globalThis.fetch;
    const res = await f(url, { cache: "no-store", signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
}

/**
 * createPoller({ fetcher(signal) → Promise<data>, onData, onError, intervalMs,
 *   timers: { set, clear }, createAbortController, hidden, onScreen })
 * → { start, stop, refresh, setHidden, setOnScreen, getState }
 */
export function createPoller({
  fetcher,
  onData = () => {},
  onError = () => {},
  intervalMs = POLL_INTERVAL_MS,
  timers,
  createAbortController,
  hidden = false,
  onScreen = true,
} = {}) {
  const setT = timers?.set ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = timers?.clear ?? ((id) => globalThis.clearTimeout(id));
  const newController = createAbortController
    ?? (() => (typeof AbortController === "function" ? new AbortController() : null));

  const s = {
    started: false, stopped: false, inFlight: false, timer: null,
    hidden: !!hidden, onScreen: !!onScreen, lastData: undefined, lastError: null, fetches: 0,
  };
  let controller = null;

  const active = () => s.started && !s.stopped && !s.hidden && s.onScreen;

  const clearTimer = () => {
    if (s.timer !== null) { clearT(s.timer); s.timer = null; }
  };

  const scheduleNext = () => {
    clearTimer();
    if (!active()) return;
    s.timer = setT(() => { s.timer = null; tick(); }, intervalMs);
  };

  async function tick() {
    if (!active() || s.inFlight) return;
    clearTimer();
    s.inFlight = true;
    s.fetches += 1;
    controller = newController();
    try {
      const data = await fetcher(controller?.signal);
      if (s.stopped) return;
      s.lastData = data;
      s.lastError = null;
      onData(data);
    } catch (err) {
      if (s.stopped || isAbortError(err)) return;
      s.lastError = err;
      onError(err, s.lastData);
    } finally {
      s.inFlight = false;
      controller = null;
      scheduleNext();
    }
  }

  return {
    /** First fetch right away (when visible); then every intervalMs after each completion. */
    start() {
      if (s.started || s.stopped) return;
      s.started = true;
      tick();
    },
    /** Stop for good: clears the timer, aborts the running request, no callback afterwards. */
    stop() {
      s.stopped = true;
      clearTimer();
      if (controller) { try { controller.abort(); } catch { /* ignore */ } }
    },
    /** Poll now (no-op while a request runs or while paused). */
    refresh() { tick(); },
    setHidden(h) {
      const was = active();
      s.hidden = !!h;
      if (!active()) clearTimer();
      else if (!was) tick();
    },
    setOnScreen(v) {
      const was = active();
      s.onScreen = !!v;
      if (!active()) clearTimer();
      else if (!was) tick();
    },
    getState() {
      return {
        started: s.started, stopped: s.stopped, inFlight: s.inFlight, scheduled: s.timer !== null,
        hidden: s.hidden, onScreen: s.onScreen, active: active(), fetches: s.fetches,
        lastData: s.lastData, lastError: s.lastError,
      };
    },
  };
}

/**
 * Compare two leaderboard snapshots (arrays of { id, rank, [valueKey] }).
 * → { [id]: { moved, isNew, valueChanged } } for every id of `next`:
 *   moved > 0 = moved UP that many places, < 0 = down, 0 = same;
 *   isNew = absent from `prev`; valueChanged = value differs from `prev`.
 * Without a previous snapshot (prev null / undefined: first load) nothing is
 * new, moved or changed.
 */
export function diffRanks(prev, next, { valueKey = "earnings30dCents" } = {}) {
  const out = {};
  const list = Array.isArray(next) ? next : [];
  if (!Array.isArray(prev)) {
    for (const it of list) if (it && it.id != null) out[it.id] = { moved: 0, isNew: false, valueChanged: false };
    return out;
  }
  const before = new Map(prev.filter((p) => p && p.id != null).map((p) => [p.id, p]));
  for (const it of list) {
    if (!it || it.id == null) continue;
    const p = before.get(it.id);
    if (!p) { out[it.id] = { moved: 0, isNew: true, valueChanged: false }; continue; }
    const moved = Number.isFinite(p.rank) && Number.isFinite(it.rank) ? p.rank - it.rank : 0;
    out[it.id] = { moved, isNew: false, valueChanged: p[valueKey] !== it[valueKey] };
  }
  return out;
}

/**
 * Movement to display for one row: a live move between two polls wins; otherwise
 * the 24 h rank change of the API (first load).
 * → { kind: 'up'|'down'|'same'|'new'|'none', n, source: 'live'|'24h'|null }
 */
export function movementOf(diff, rankChange24h) {
  if (diff?.isNew) return { kind: "new", n: 0, source: "live" };
  if (diff && diff.moved > 0) return { kind: "up", n: diff.moved, source: "live" };
  if (diff && diff.moved < 0) return { kind: "down", n: -diff.moved, source: "live" };
  if (Number.isFinite(rankChange24h)) {
    if (rankChange24h > 0) return { kind: "up", n: rankChange24h, source: "24h" };
    if (rankChange24h < 0) return { kind: "down", n: -rankChange24h, source: "24h" };
    return { kind: "same", n: 0, source: "24h" };
  }
  return { kind: "none", n: 0, source: null };
}
