#!/usr/bin/env node
/**
 * scripts/paymentProofSchedule.test.mjs — payment proof SCHEDULING regression tests.
 *
 * Bug: at 02:22 Morocco time, scheduling 02:30 the same day was refused ("L'heure de
 * publication doit être dans le futur"). Root cause: the server converted Casablanca
 * wall-clock times with the runtime's bundled time-zone data (Node 22, ICU tz 2025b),
 * which still applies UTC+1 to Morocco; since 2026-09-20 Morocco is UTC+0 (IANA tzdata
 * 2026c). 02:30 local became 01:30Z — before "now" (02:22Z). Fix: one explicit rule
 * table (src/lib/casablancaTime.js) and one schedule check (src/lib/paymentProofSchedule.js)
 * shared by the server and the admin browser.
 *
 *   1. The reported case and its neighbours (accepted / refused)
 *   2. Morocco ⇄ UTC conversion (table vs system zoneinfo, vs Intl before the change)
 *   3. Browser and server use the same rule; the result never depends on the runtime's
 *      own time-zone data
 *   4. Midnight and date changes, repeated / skipped hours, seconds and minute boundaries
 *   5. Service level (the /validate path) and unchanged 72-hour visibility
 *
 * Run: node scripts/paymentProofSchedule.test.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makePaymentProofFakeDb } from './lib/paymentProofFakeDb.mjs';

const T = await import('../src/lib/casablancaTime.js');
const SCH = await import('../src/lib/paymentProofSchedule.js');
const P = await import('../src/lib/paymentProofs.js');
const S = await import('../src/lib/services/paymentProofService.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const Z = (iso) => Date.parse(iso);
const H = 3_600_000, MIN = 60_000;
const base = { displayName: 'Amina K.', amount: '1500', clientRef: 'ref-schedule-0001', privacyConfirmed: true, authenticityConfirmed: true };
const serverCheck = (date, time, nowMs) => P.validateProofInput({ ...base, date, time }, { nowMs });

// ── 1. The reported case ─────────────────────────────────────────────────────
console.log('\n1. Reported case: now 02:22 in Morocco (2026-11-11, UTC+0)');
{
  const now = Z('2026-11-11T02:22:00Z');
  ok('the device and the server agree it is 02:22 in Morocco', JSON.stringify(T.casablancaLocal(now)) === '{"date":"2026-11-11","time":"02:22"}');
  const a = serverCheck('2026-11-11', '02:30', now);
  ok('02:22 → 02:30 the same day: ACCEPTED, stored as 02:30Z', !a.errors.scheduledAt && a.value.scheduledAt.toISOString() === '2026-11-11T02:30:00.000Z', JSON.stringify(a.errors));
  ok('02:22 → 02:20 the same day: REFUSED (SCHEDULE_IN_PAST)', serverCheck('2026-11-11', '02:20', now).errors.scheduledAt === 'SCHEDULE_IN_PAST');
  ok('02:22 → 02:22 (now): REFUSED', serverCheck('2026-11-11', '02:22', now).errors.scheduledAt === 'SCHEDULE_IN_PAST');
  const tomorrow = serverCheck('2026-11-12', '02:20', now);
  ok('a time on the next day (even earlier in the day): ACCEPTED', !tomorrow.errors.scheduledAt && tomorrow.value.scheduledAt.toISOString() === '2026-11-12T02:20:00.000Z');
  ok('yesterday: REFUSED', serverCheck('2026-11-10', '23:59', now).errors.scheduledAt === 'SCHEDULE_IN_PAST');
  // The defect itself: with the outdated rule (+01), 02:30 local would be 01:30Z — before now.
  const outdated = Date.UTC(2026, 10, 11, 2, 30) - 60 * MIN;
  ok('(cause) with the outdated +01 rule 02:30 would mean 01:30Z, i.e. 52 min in the past', outdated < now && now - outdated === 52 * MIN);
}

// ── 2. Morocco ⇄ UTC conversion ──────────────────────────────────────────────
console.log('\n2. Morocco ⇄ UTC conversion');
{
  const conv = (d, t) => P.casablancaToUtc(d, t).ms;
  ok('2026-11-11 02:30 → 02:30Z (UTC+0 since 2026-09-20)', conv('2026-11-11', '02:30') === Z('2026-11-11T02:30:00Z'));
  ok('2026-07-01 10:00 → 09:00Z (UTC+1 before the change)', conv('2026-07-01', '10:00') === Z('2026-07-01T09:00:00Z'));
  ok('2026-03-01 10:00 → 10:00Z (Ramadan, UTC+0)', conv('2026-03-01', '10:00') === Z('2026-03-01T10:00:00Z'));
  ok('2027-06-15 12:00 → 12:00Z (no more summer time after the change)', conv('2027-06-15', '12:00') === Z('2027-06-15T12:00:00Z'));
  ok('round trip: every stored instant displays back as the typed date and time (each 37 min, 2025–2027)', (() => {
    for (let t = Z('2025-01-01T00:00:00Z'); t < Z('2028-01-01T00:00:00Z'); t += 37 * MIN) {
      const m = Math.floor(t / MIN) * MIN;
      const { date, time } = T.casablancaLocal(m);
      if (!T.casablancaCandidates(date, time).candidates?.includes(m)) return false;
    }
    return true;
  })());

  // The table against the system's IANA zoneinfo (authoritative), when the system has it.
  let zoneinfo = null;
  try {
    const out = execFileSync('zdump', ['-v', '-c', '2018,2031', 'Africa/Casablanca'], { encoding: 'utf8' });
    zoneinfo = out.split('\n').map((l) => /UT = .* gmtoff=(-?\d+)/.exec(l) && { line: l, off: Number(/gmtoff=(-?\d+)/.exec(l)[1]) / 60 }).filter(Boolean);
  } catch { /* no zdump on this machine */ }
  let version = '';
  try { version = readFileSync('/usr/share/zoneinfo/tzdata.zi', 'utf8').split('\n')[0]; } catch { /* none */ }
  if (zoneinfo && zoneinfo.length && version.includes(T.CASABLANCA_TZDATA_VERSION)) {
    const sample = [];
    for (let t = Z('2018-07-01T00:00:00Z'); t < Z('2031-01-01T00:00:00Z'); t += 6 * H) sample.push(t);
    const zd = (t) => {
      const out = execFileSync('bash', ['-c', `TZ=Africa/Casablanca date -d @${Math.floor(t / 1000)} +%z`], { encoding: 'utf8' }).trim();
      return (out[0] === '-' ? -1 : 1) * (Number(out.slice(1, 3)) * 60 + Number(out.slice(3, 5)));
    };
    const picks = sample.filter((_, i) => i % 97 === 0); // ~190 spot checks through the system C library
    const bad = picks.filter((t) => zd(t) !== T.casablancaOffsetMinutes(t));
    ok(`table = system zoneinfo (${version.replace('# ', '')}) at ${picks.length} instants 2018–2030`, bad.length === 0, bad.slice(0, 3).map((t) => new Date(t).toISOString()).join());
    const trans = execFileSync('bash', ['-c', "zdump -v -c 2018,2031 Africa/Casablanca | awk '/gmtoff/' | awk 'NR%2==0' | wc -l"], { encoding: 'utf8' }).trim();
    ok('every system transition 2018–2030 is in the table', Number(trans) === T.CASABLANCA_TRANSITIONS.length + 2 /* 2018 Mar 25 + May 13, before the table */, trans);
  } else {
    console.log(`  SKIP  system zoneinfo comparison (zdump or tzdata ${T.CASABLANCA_TZDATA_VERSION} not available here: "${version}")`);
  }
  // Before the 2026-09-20 change every tzdata version agrees: the table must equal Intl there.
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Casablanca', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const intlLocal = (t) => { const p = {}; for (const x of fmt.formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = x.value; return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`; };
  let diff = 0, n = 0;
  for (let t = Z('2018-06-17T02:00:00Z'); t < Z('2026-09-20T01:00:00Z'); t += 3 * H + 7 * MIN) {
    n++; const l = T.casablancaLocal(t); if (`${l.date} ${l.time}` !== intlLocal(t)) diff++;
  }
  ok(`table = this runtime's Intl before 2026-09-20 (${n} instants)`, diff === 0, String(diff));
  console.log(`  INFO  runtime Intl time-zone data: tz ${process.versions.tz || '?'} — now in Casablanca per Intl: ${intlLocal(Date.now())}, per the table: ${T.casablancaLocal(Date.now()).date} ${T.casablancaLocal(Date.now()).time}`);
}

// ── 3. Browser and server: one rule, independent of runtime time-zone data ───
console.log('\n3. Browser and server use the same rule');
{
  const ui = read('../src/app/admin/payment-proofs/ui.jsx');
  const sb = read('../src/app/admin/payment-proofs/ScheduleBuilder.jsx');
  const pl = read('../src/app/admin/payment-proofs/ProofsList.jsx');
  ok('the browser imports the server\'s schedule check and Casablanca table (no own Intl time-zone conversion)',
    /import \{ checkProofSchedule \} from "@\/lib\/paymentProofSchedule"/.test(ui) && /from "@\/lib\/casablancaTime"/.test(ui)
    && /return checkProofSchedule\(date, time, nowMs\)\.error \|\| null;/.test(ui) && !/timeZone: TZ/.test(ui));
  ok('the server validation uses the same check', /checkProofSchedule\(src\.date, src\.time, nowMs\)/.test(read('../src/lib/paymentProofs.js')));
  ok('the schedule builder and the edit dialog check the time with it before sending', /scheduleProblem\(row\.date, row\.time\)/.test(sb) && /scheduleProblem\(f\.date, f\.time\)/.test(pl));
  // Same verdict and same instant for the "browser" function and the server validation over a sweep.
  let mismatch = 0, count = 0;
  for (let now = Z('2026-01-01T00:00:00Z'); now < Z('2027-01-01T00:00:00Z'); now += 61 * MIN + 13_000) {
    for (const lead of [-30, -1, 0, 1, 2, 8, 90, 24 * 60]) {
      const { date, time } = T.casablancaLocal(now + lead * MIN);
      const b = SCH.checkProofSchedule(date, time, now);
      const s = serverCheck(date, time, now);
      count++;
      if ((b.error || null) !== (s.errors.scheduledAt || null) || (b.ms ?? null) !== (s.value.scheduledAt ? s.value.scheduledAt.getTime() : null)) mismatch++;
    }
  }
  ok(`browser check = server validation (verdict and instant) in ${count} cases`, mismatch === 0, String(mismatch));
  // A device or server whose Intl data is wrong (here: forced to +01 everywhere, like the outdated ICU) changes nothing.
  const Real = Intl.DateTimeFormat;
  const before = ['02:30', '02:20'].map((t) => JSON.stringify(SCH.checkProofSchedule('2026-11-11', t, Z('2026-11-11T02:22:00Z'))));
  globalThis.Intl.DateTimeFormat = function Broken(locale, opts = {}) { return new Real(locale, { ...opts, timeZone: 'Etc/GMT-2' }); };
  try {
    const after = ['02:30', '02:20'].map((t) => JSON.stringify(SCH.checkProofSchedule('2026-11-11', t, Z('2026-11-11T02:22:00Z'))));
    ok('the result does not depend on the runtime\'s own time-zone data (Intl forced to a wrong zone)', JSON.stringify(before) === JSON.stringify(after) && T.casablancaToday(Z('2026-11-11T23:30:00Z')) === '2026-11-11');
  } finally { globalThis.Intl.DateTimeFormat = Real; }
  ok('the process time zone (TZ) is never used: Date.UTC / epoch only', !/getHours\(|getDate\(|getTimezoneOffset|toLocale/.test(read('../src/lib/casablancaTime.js') + read('../src/lib/paymentProofSchedule.js')));
}

// ── 4. Midnight, date changes, clock changes, seconds, minute boundaries ─────
console.log('\n4. Midnight, date changes, clock changes, seconds');
{
  // UTC+0 period
  const n1 = Z('2026-11-11T23:55:00Z');
  ok('23:55 → 00:05 the NEXT day: accepted', SCH.checkProofSchedule('2026-11-12', '00:05', n1).ms === Z('2026-11-12T00:05:00Z'));
  ok('23:55 → 23:50 the same day: refused', SCH.checkProofSchedule('2026-11-11', '23:50', n1).error === 'SCHEDULE_IN_PAST');
  ok('"today" switches at Moroccan midnight', T.casablancaToday(Z('2026-11-11T23:59:59Z')) === '2026-11-11' && T.casablancaToday(Z('2026-11-12T00:00:00Z')) === '2026-11-12');
  // UTC+1 period: Moroccan midnight is 23:00Z the previous UTC day
  const n2 = Z('2026-07-01T23:30:00Z'); // 2026-07-02 00:30 in Morocco
  ok('UTC+1: at 23:30Z it is already the next day in Morocco', T.casablancaToday(n2) === '2026-07-02');
  ok('UTC+1: 00:30 → 00:40 (next Moroccan day, still the same UTC day): accepted, 23:40Z', SCH.checkProofSchedule('2026-07-02', '00:40', n2).ms === Z('2026-07-01T23:40:00Z'));
  ok('UTC+1: 00:30 → 23:59 the previous Moroccan day: refused', SCH.checkProofSchedule('2026-07-01', '23:59', n2).error === 'SCHEDULE_IN_PAST');
  ok('31 Dec → 1 Jan (year change): accepted', SCH.checkProofSchedule('2027-01-01', '00:10', Z('2026-12-31T23:55:00Z')).ms === Z('2027-01-01T00:10:00Z'));
  // Repeated hour when clocks go back (2026-02-15 03:00 → 02:00 and 2026-09-20 02:00 → 01:00)
  ok('repeated hour: 2026-02-15 02:30 has two instants (01:30Z, 02:30Z)', JSON.stringify(T.casablancaCandidates('2026-02-15', '02:30').candidates) === JSON.stringify([Z('2026-02-15T01:30:00Z'), Z('2026-02-15T02:30:00Z')]));
  const second = Z('2026-02-15T02:22:00Z'); // 02:22 for the SECOND time
  ok('in the second 02:xx hour, 02:22 → 02:30 is accepted (the later 02:30, 02:30Z)', SCH.checkProofSchedule('2026-02-15', '02:30', second).ms === Z('2026-02-15T02:30:00Z'));
  ok('…and 02:22 → 02:20 is refused (both of its instants are past)', SCH.checkProofSchedule('2026-02-15', '02:20', second).error === 'SCHEDULE_IN_PAST');
  ok('before the repeated hour, 02:30 still means its first instant (01:30Z)', SCH.checkProofSchedule('2026-02-15', '02:30', Z('2026-02-14T12:00:00Z')).ms === Z('2026-02-15T01:30:00Z'));
  ok('2026-09-20 change (+01 → +00): 01:30 repeated (00:30Z and 01:30Z)', JSON.stringify(T.casablancaCandidates('2026-09-20', '01:30').candidates) === JSON.stringify([Z('2026-09-20T00:30:00Z'), Z('2026-09-20T01:30:00Z')]));
  ok('skipped hour (2026-03-22 02:30) → NONEXISTENT_LOCAL_TIME', SCH.checkProofSchedule('2026-03-22', '02:30', Z('2026-03-01T00:00:00Z')).error === 'NONEXISTENT_LOCAL_TIME');
  // Seconds and minute boundaries (the clock has seconds; the input has minutes)
  const n3 = Z('2026-11-11T02:22:30Z');
  ok('02:22:30 → 02:23 (30 s ahead, under the 1-minute minimum): refused', SCH.checkProofSchedule('2026-11-11', '02:23', n3).error === 'SCHEDULE_IN_PAST');
  ok('02:22:30 → 02:24 (90 s ahead): accepted', SCH.checkProofSchedule('2026-11-11', '02:24', n3).ms === Z('2026-11-11T02:24:00Z'));
  ok('02:22:00.000 → 02:23 (exactly 1 minute): accepted', SCH.checkProofSchedule('2026-11-11', '02:23', Z('2026-11-11T02:22:00Z')).ms === Z('2026-11-11T02:23:00Z'));
  ok('"02:30:00" (browsers that send seconds) is the same as "02:30"', SCH.checkProofSchedule('2026-11-11', '02:30:00', Z('2026-11-11T02:22:00Z')).ms === Z('2026-11-11T02:30:00Z'));
  ok('non-zero seconds, malformed or impossible values → INVALID_DATETIME', ['02:30:15', '2:30', '24:00', '02:60', ''].every((t) => SCH.checkProofSchedule('2026-11-11', t, 0).error === 'INVALID_DATETIME')
    && SCH.checkProofSchedule('2026-02-30', '10:00', 0).error === 'INVALID_DATETIME');
  ok('366-day limit unchanged', SCH.checkProofSchedule('2027-11-12', '02:30', Z('2026-11-11T02:22:00Z')).error === 'SCHEDULE_TOO_FAR'
    && P.PROOF_LIMITS.MAX_SCHEDULE_AHEAD_DAYS === 366 && P.PROOF_LIMITS.MIN_LEAD_MS === 60_000);
}

// ── 5. Service level and unchanged visibility ────────────────────────────────
console.log('\n5. Service (/validate path) and the 72-hour rule');
{
  const db = makePaymentProofFakeDb();
  const now = new Date('2026-11-11T02:22:00Z');
  const items = [
    { ...base, clientRef: 'ref-sched-0001', date: '2026-11-11', time: '02:30' },
    { ...base, clientRef: 'ref-sched-0002', date: '2026-11-11', time: '02:20' },
    { ...base, clientRef: 'ref-sched-0003', date: '2026-11-12', time: '09:00' },
  ];
  const r = await S.validatePaymentProofBatch(items, { db, now });
  ok('review of the batch: 02:30 ok, 02:20 refused, tomorrow ok; times shown back as typed', r.items[0].ok && r.items[0].scheduledAt === '2026-11-11T02:30:00.000Z'
    && r.items[0].scheduledLocal.time === '02:30' && r.items[1].errors.scheduledAt === 'SCHEDULE_IN_PAST' && r.items[2].ok && r.items[2].scheduledLocal.date === '2026-11-12');
  ok('nothing written by the review', db._tables.paymentProof.length === 0);
  ok('72-hour visibility rule unchanged', P.VISIBILITY_HOURS === 72 && P.VISIBILITY_MS === 72 * H
    && P.isVisibleAt({ status: 'PUBLISHED', publishedAt: new Date(now.getTime() - 72 * H + 1) }, now.getTime())
    && !P.isVisibleAt({ status: 'PUBLISHED', publishedAt: new Date(now.getTime() - 72 * H) }, now.getTime()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
