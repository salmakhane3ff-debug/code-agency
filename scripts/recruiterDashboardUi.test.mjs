#!/usr/bin/env node
/**
 * scripts/recruiterDashboardUi.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System, Phase 7 Stage C (UI). Zero dependencies, no database, no server.
 *   1. the pure helpers the recruiter pages import (src/app/recruiter/recruiterUiState.js,
 *      src/app/recruiter/wallet/walletUi.js): login redirect decision (ONLY 401 / 403 disabled),
 *      permissions, progress "x / T مبيعات" (nothing when the count is withheld), badges (qualified,
 *      reward state + cycle; Phase 7 Stage E: the neutral "مدعو عبر الشبكة" — every member of the network
 *      N(R) is reward-eligible, the Stage C "خارج ربطك" exclusion badge is gone), group progress "q / groupSize", awarded vs reversed sums,
 *      de-duplicated paging, the stale-response gate, the level label, wallet group rows and gross / net
 *   2. the helpers on top of the REAL recruiterVisibility.js projections (canViewOrders off → no count)
 *   3. Landing Page Only Mode: /recruiter and /affiliate/activate are never redirected (real functions)
 *   4. static source assertions on the pages (401-only redirects, stale guards, creation buttons gated
 *      by canCreateAffiliates, wallet labels / KYC-unknown state, verification error, password guard)
 * Run: node scripts/recruiterDashboardUi.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const U = await import('../src/app/recruiter/recruiterUiState.js');
const W = await import('../src/app/recruiter/wallet/walletUi.js');
const V = await import('../src/lib/recruiterVisibility.js');
const L = await import('../src/lib/landingMode.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. pure helpers ─────────────────────────────────────────────────────────────
console.log('\n1. Pure helpers (recruiterUiState.js / walletUi.js)');
{
  ok('authAction: 401 → login (whatever the code)', U.authAction(401, 'UNAUTHORIZED') === 'login' && U.authAction(401, 'SERVER_ERROR') === 'login' && U.authAction(401, null) === 'login');
  ok('authAction: 403 RECRUITER_DISABLED → disabled; 403 FORBIDDEN / NOT_FOUND → null (stay, show the error)',
    U.authAction(403, 'RECRUITER_DISABLED') === 'disabled' && U.authAction(403, 'FORBIDDEN') === null && U.authAction(403, 'SERVER_ERROR') === null);
  ok('authAction: 500 / 502 / 503 / 429 / network (0) / 404 → null (error + retry, never the login page)',
    [500, 502, 503, 429, 0, 404, 400].every((s) => U.authAction(s, s === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR') === null));

  ok('permsFromMe: explicit true only; missing / malformed → creation hidden',
    eq(U.permsFromMe({ permissions: { canViewOrders: true, canCreateAffiliates: true } }), { canViewOrders: true, canCreateAffiliates: true })
    && eq(U.permsFromMe({ permissions: { canViewOrders: false, canCreateAffiliates: false } }), { canViewOrders: false, canCreateAffiliates: false })
    && eq(U.permsFromMe({ permissions: { canCreateAffiliates: 'yes' } }), { canViewOrders: false, canCreateAffiliates: false })
    && eq(U.permsFromMe(null), { canViewOrders: false, canCreateAffiliates: false }));

  const p = U.progressDisplay({ realDelivered: 7, individualThreshold: 10, groupThreshold: 5, identityApproved: true, qualifiedIndividual: false, qualifiedGroup: true });
  ok('progressDisplay: "7 / 10 مبيعات", 70 %, not reached, qualifiedGroup', p && p.text === '7 / 10 مبيعات' && p.pct === 70 && p.reached === false && p.qualifiedGroup === true && p.qualifiedIndividual === false, JSON.stringify(p));
  const over = U.progressDisplay({ realDelivered: 25, individualThreshold: 10, qualifiedIndividual: true });
  ok('progressDisplay: over the threshold → bar capped at 100 %, reached', over.pct === 100 && over.reached && over.text === '25 / 10 مبيعات');
  ok('progressDisplay: realDelivered null (canViewOrders off) / no progress → null (no count, no bar, no zero)',
    U.progressDisplay({ realDelivered: null, individualThreshold: 10, qualifiedIndividual: null }) === null && U.progressDisplay(null) === null && U.progressDisplay({}) === null);
  ok('progressDisplay: unknown threshold → the count only, no bar', (() => { const x = U.progressDisplay({ realDelivered: 3, individualThreshold: null }); return x.text === '3 مبيعات' && x.pct === null && x.threshold === null; })());
  ok('percent: 0 when max is unknown; floor; clamped', U.percent(3, null) === 0 && U.percent(1, 3) === 33 && U.percent(50, 10) === 100 && U.percent(-2, 10) === 0);

  const keys = (n) => U.nodeBadges(n).map((b) => b.key);
  // Stage E (approved rule): an invited member (linkedToMe false) is reward-eligible like any other — a neutral
  // information badge first, then the same qualification / reward badges (Stage C: only "خارج ربطك").
  ok('Stage E nodeBadges: linkedToMe false → "مدعو عبر الشبكة" (neutral, information) + the qualification and reward badges like any member',
    eq(keys({ linkedToMe: false, progress: { realDelivered: 20, individualThreshold: 10, qualifiedIndividual: true, qualifiedGroup: true }, rewardState: { state: 'AWARDED', cycle: 1 } }), ['invited', 'qualified', 'qualifiedGroup', 'awarded'])
    && U.nodeBadges({ linkedToMe: false })[0].label === 'مدعو عبر الشبكة' && U.nodeBadges({ linkedToMe: false })[0].tone === 'slate' && U.NETWORK_INVITED_LABEL === 'مدعو عبر الشبكة'
    && !/خارج ربطك|لا تُحتسب/.test(JSON.stringify(U)) && U.nodeBadges(null).length === 0 && U.NOT_LINKED_LABEL === undefined);
  const aw = U.nodeBadges({ linkedToMe: true, progress: { realDelivered: 12, individualThreshold: 10, qualifiedIndividual: true, qualifiedGroup: false }, rewardState: { state: 'AWARDED', cycle: 2 } });
  ok('nodeBadges: linked + qualified + AWARDED cycle 2 → "مؤهَّل للمكافأة", "مكافأة ممنوحة · الدورة 2"',
    eq(aw.map((b) => b.key), ['qualified', 'awarded']) && aw[1].label === 'مكافأة ممنوحة · الدورة 2' && aw[1].tone === 'green', JSON.stringify(aw));
  const rv = U.nodeBadges({ linkedToMe: true, progress: { realDelivered: null }, rewardState: { state: 'REVERSED', cycle: 1 } });
  ok('nodeBadges: canViewOrders off → no qualified badge, but the reward state of a linked node stays ("مكافأة ملغاة · الدورة 1")',
    eq(rv.map((b) => b.key), ['reversed']) && rv[0].label === 'مكافأة ملغاة · الدورة 1' && rv[0].tone === 'red');
  ok('nodeBadges: NONE → no reward badge', eq(keys({ linkedToMe: true, progress: null, rewardState: { state: 'NONE', cycle: null } }), []));

  const g = U.groupProgressDisplay({ groupEnabled: true, groupSize: 10, progressTowardNextGroup: 7, qualifiedForGroup: 17, activeGroupRewards: 1, groupThreshold: 10 });
  ok('groupProgressDisplay: "7 / 10", 70 %, qualified 17, active 1', g.text === '7 / 10' && g.pct === 70 && g.qualified === 17 && g.active === 1 && g.enabled === true, JSON.stringify(g));
  ok('groupProgressDisplay: disabled flag kept; toward clamped to size; unknown size → "—"',
    U.groupProgressDisplay({ groupEnabled: false, groupSize: 10, progressTowardNextGroup: 3 }).enabled === false
    && U.groupProgressDisplay({ groupEnabled: true, groupSize: 5, progressTowardNextGroup: 9 }).text === '5 / 5'
    && U.groupProgressDisplay({ groupEnabled: true, groupSize: null }).text === '—');

  const r = U.rewardAmountsDisplay({ individual: { awarded: 3, awardedCents: 45000, reversed: 1, reversedCents: 15000 }, group: { awarded: 1, awardedCents: 100000, reversed: 0, reversedCents: 0 } });
  ok('rewardAmountsDisplay: gross 145000, reversed 15000, net 130000; per-type nets', r.grossCents === 145000 && r.reversedCents === 15000 && r.netCents === 130000 && r.individual.netCents === 30000 && r.group.netCents === 100000, JSON.stringify(r));
  ok('rewardAmountsDisplay: missing data → zeros (never NaN)', eq(U.rewardAmountsDisplay(null), { individual: { awarded: 0, awardedCents: 0, reversed: 0, reversedCents: 0, netCents: 0 }, group: { awarded: 0, awardedCents: 0, reversed: 0, reversedCents: 0, netCents: 0 }, grossCents: 0, reversedCents: 0, netCents: 0 }));
  ok('fmtMadCents: "1.500,00 درهم"-style (fr-MA grouping), 2 decimals', /^1[.\s]?500,00 درهم$/.test(U.fmtMadCents(150000).replace(/\u202f|\u00a0/g, ' ')), U.fmtMadCents(150000));

  ok('mergeById: appends new rows, drops duplicates and rows without id, keeps the order',
    eq(U.mergeById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: null }, { id: 'a' }]).map((x) => x.id), ['a', 'b', 'c'])
    && eq(U.mergeById(null, [{ id: 'x' }, { id: 'x' }]).map((x) => x.id), ['x']));
  // rapid clicks: the same page delivered twice → still each row once
  const page = [{ id: 'n1' }, { id: 'n2' }];
  ok('mergeById: the same page merged twice (double click / retry race) → no duplicate row', U.mergeById(U.mergeById([], page), page).length === 2);

  const gate = U.createRequestGate();
  const t1 = gate.begin(); const t2 = gate.begin();
  ok('createRequestGate: only the latest token is current (old root answer discarded)', !gate.isCurrent(t1) && gate.isCurrent(t2));
  gate.invalidate();
  ok('createRequestGate: invalidate() makes every pending answer stale', !gate.isCurrent(t2));

  ok('levelLabel: absolute level wording "المستوى N" / "بدون مستوى"', U.levelLabel(3) === 'المستوى 3' && U.levelLabel(null) === 'بدون مستوى' && U.levelLabel(0) === 'بدون مستوى');

  ok('walletUi.rewardRowTitle: group rows labelled, individual rows null',
    W.rewardRowTitle({ type: 'GROUP_REWARD' }) === 'مكافأة المجموعة' && W.rewardRowTitle({ type: 'GROUP_REVERSAL' }) === 'إلغاء مكافأة المجموعة'
    && W.rewardRowTitle({ type: 'RECRUIT_REWARD' }) === null && W.rewardRowTitle({ type: 'toString' }) === null);
  const d = W.groupRowDetail({ type: 'GROUP_REWARD', cycle: 2, groupSize: 10, requiredDeliveredOrders: 10 });
  ok('walletUi.groupRowDetail: cycle and group size (and the per-affiliate threshold)', d.includes('الدورة 2') && d.includes('مجموعة من 10 أفلييت') && d.includes('10 طلبيات'), d);
  ok('walletUi.groupRowDetail: a reversal explains why; unknown parts are left out',
    W.groupRowDetail({ type: 'GROUP_REVERSAL', cycle: 1, groupSize: 5 }).startsWith('عدد الأفلييت المؤهَّلين أصبح أقل') && W.groupRowDetail({}) === '—');
  const gn = W.walletGrossNet({ grossCents: 145000, reversedCents: 15000 }, 130000);
  ok('walletUi.walletGrossNet: no adjustment when net = gross − reversed', gn.adjustmentCents === 0 && gn.netCents === 130000);
  ok('walletUi.walletGrossNet: an admin adjustment is shown as the difference (never hidden)', W.walletGrossNet({ grossCents: 145000, reversedCents: 15000 }, 125000).adjustmentCents === -5000);
}

// ── 2. on top of the real projections ───────────────────────────────────────────
console.log('\n2. Helpers on the real recruiterVisibility.js projections');
{
  const hidden = V.toRecruiterNetworkNodeView({ id: 'a', linkedToMe: true, orders: null, progress: { realDelivered: null, individualThreshold: 10, groupThreshold: 10, identityApproved: true, qualifiedIndividual: true, qualifiedGroup: true }, rewardState: { state: 'AWARDED', cycle: 1 } });
  ok('canViewOrders off: node progress → no display, no qualified badge, reward state kept',
    U.progressDisplay(hidden.progress) === null && eq(U.nodeBadges(hidden).map((b) => b.key), ['awarded']));
  const invited = V.toRecruiterNetworkNodeView({ id: 'b', linkedToMe: false, progress: { realDelivered: 4, individualThreshold: 10 }, rewardState: { state: 'AWARDED', cycle: 1 } });
  // Stage E: the projection keeps the reward state of every member (Stage B dropped it for non-linked nodes).
  ok('Stage E: an invited network member: progress visible (4 / 10), reward state kept by the projection, badges "مدعو عبر الشبكة" + awarded',
    U.progressDisplay(invited.progress).text === '4 / 10 مبيعات' && eq(invited.rewardState, { state: 'AWARDED', cycle: 1 }) && eq(U.nodeBadges(invited).map((b) => b.key), ['invited', 'awarded']));
  const item = V.toRecruiterAffiliateListItemView({ id: 'c', linkedToMe: true, parent: { id: 'p', username: 'pp', name: 'P', linkedToMe: false }, progress: { realDelivered: 10, individualThreshold: 10, identityApproved: true, qualifiedIndividual: true, qualifiedGroup: true }, rewardState: { state: 'NONE' } }, new Set());
  const item2 = V.toRecruiterAffiliateListItemView({ id: 'd', parent: null, progress: null, rewardState: null }, new Set());
  ok('affiliate list item: parent kept with linkedToMe false (masked parentId), linkedToMe taken from the row (Stage E: true / missing → false), qualified badges',
    item.parent?.id === 'p' && item.parent.linkedToMe === false && item.parentId === null && item.linkedToMe === true && eq(U.nodeBadges(item).map((b) => b.key), ['qualified', 'qualifiedGroup'])
    && item2.linkedToMe === false && eq(U.nodeBadges(item2).map((b) => b.key), ['invited']));
  const s = V.toRecruiterProgressSummaryView({ linkedAffiliates: 12, downlineAffiliates: 30, qualifiedForGroup: 7, groupSize: 10, activeGroupRewards: 0, progressTowardNextGroup: 7, groupEnabled: true, individualEnabled: false, rewards: { individual: { awarded: 2, awardedCents: 30000, reversed: 1, reversedCents: 15000 } } });
  ok('progress summary → group "7 / 10", individual off, gross 30000 / reversed 15000',
    U.groupProgressDisplay(s).text === '7 / 10' && s.individualEnabled === false && U.rewardAmountsDisplay(s.rewards).grossCents === 30000 && U.rewardAmountsDisplay(s.rewards).reversedCents === 15000);
  const hist = V.toRecruiterWalletView({ rewards: [{ type: 'GROUP_REWARD', amountCents: 100000, cycle: 1, groupSize: 10, requiredDeliveredOrders: 10, settingsVersion: 3 }, { type: 'GROUP_REVERSAL', amountCents: -100000, cycle: 1, groupSize: 10 }] }).rewards;
  ok('wallet history group rows (real projection) → titles and details', W.rewardRowTitle(hist[0]) === 'مكافأة المجموعة' && W.rewardRowTitle(hist[1]) === 'إلغاء مكافأة المجموعة' && W.groupRowDetail(hist[0]).includes('الدورة 1'));
}

// ── 3. Landing Page Only Mode allowlist ─────────────────────────────────────────
console.log('\n3. Landing Page Only Mode never redirects /recruiter or /affiliate/activate (real landingMode.js)');
{
  const cfg = { enabled: true, redirectUrl: '/landing/offer', allowedPaths: [] };
  const ev = (pathname, config = cfg) => L.evaluateLandingRedirect({ pathname, origin: 'https://shop.example.com', config });
  for (const p of ['/recruiter', '/recruiter/login', '/recruiter/wallet', '/recruiter/network/stats', '/recruiter/affiliates', '/affiliate/activate', '/affiliate/activate/step']) {
    ok(`enabled mode: ${p} → next (isAlwaysAllowed)`, ev(p).action === 'next' && L.isAlwaysAllowed(p));
  }
  ok('fail-safe: also with an INVALID redirect URL and with an external target', ev('/recruiter', { ...cfg, redirectUrl: 'javascript:alert(1)' }).action === 'next' && ev('/affiliate/activate', { ...cfg, redirectUrl: 'https://other.example.org/x' }).action === 'next');
  ok('prefix boundary: /recruiterx and /affiliate/activated are NOT allowlisted (still redirected)', ev('/recruiterx').action === 'redirect' && ev('/affiliate/activated').action === 'redirect');
  ok('existing behaviour kept: /, /products/1, /affiliate/dashboard redirect; /admin, /api stay; disabled mode → next',
    ev('/').action === 'redirect' && ev('/products/1').action === 'redirect' && ev('/affiliate/dashboard').action === 'redirect'
    && ev('/admin').action === 'next' && ev('/api/x').action === 'next' && ev('/', { ...cfg, enabled: false }).action === 'next');
  ok('landingMode.js: the allowlist is the ALWAYS_PREFIXES constant (one place)', /const ALWAYS_PREFIXES = \["\/admin", "\/api", "\/_next", "\/uploads", "\/recruiter", "\/affiliate\/activate"\];/.test(read('src/lib/landingMode.js')));
}

// ── 4. static source assertions ─────────────────────────────────────────────────
console.log('\n4. Static assertions on the recruiter pages');
{
  const PAGES = ['src/app/recruiter/page.jsx', 'src/app/recruiter/affiliates/page.jsx', 'src/app/recruiter/affiliates/new/page.jsx', 'src/app/recruiter/affiliates/activation/page.jsx',
    'src/app/recruiter/password/page.jsx', 'src/app/recruiter/verification/page.jsx', 'src/app/recruiter/wallet/page.jsx',
    'src/app/recruiter/network/page.jsx', 'src/app/recruiter/network/stats/page.jsx'];
  const src = Object.fromEntries(PAGES.map((f) => [f, stripJs(read(f))]));
  const ui = stripJs(read('src/app/recruiter/network/networkUi.jsx'));
  const BAD = [
    /status === 401 \|\| (res|r)\.status === 403\b(?!\s*&&)/, // any 403 → login
    /toLogin\((res|r)\.status === 403 \? code : "UNAUTHORIZED"\)/, // every non-ok → login
    /setNotice\(recruiterErrorLabel\(null\)\)/, // network failure as a dead-end notice (no retry)
  ];
  const offenders = PAGES.filter((f) => BAD.some((re) => re.test(src[f])));
  ok('no recruiter page sends to the login page on a non-401 answer (no "401 || 403", no "every failure → login", no retry-less network notice)', offenders.length === 0, offenders.join(', '));
  ok('every recruiter page decides with authAction (directly or through networkUi.handleAuth)',
    PAGES.every((f) => /authAction\(/.test(src[f]) || /handleAuth\(/.test(src[f])) && /const action = authAction\(result\.status, result\.code\);/.test(ui));
  ok('every recruiter page offers a retry for a failed load (data-retry / retry handler / ErrorBox onRetry)',
    PAGES.every((f) => /data-retry|onRetry=|data-identity-retry|data-gross-retry/.test(src[f])));

  const net = src['src/app/recruiter/network/page.jsx'];
  ok('network: stale answers discarded (request gates) and branches / pages de-duplicated (in-flight sets + mergeById)',
    /topGate\.isCurrent\(token\)/.test(net) && /statsGate\.isCurrent\(token\)/.test(net) && /scopeGate\.isCurrent\(scope\)/.test(net)
    && /branchInFlight\.current\.has\(id\)/.test(net) && (net.match(/mergeById\(/g) || []).length >= 4);
  ok('network: a failed "load more" keeps the rows (moreError apart from the first-page error)', /moreError: r\.code/.test(net) && /top\.moreError && <ErrorBox/.test(net));
  ok('stats: stale answers discarded', /gate\.isCurrent\(token\)/.test(src['src/app/recruiter/network/stats/page.jsx']));
  const aff = src['src/app/recruiter/affiliates/page.jsx'];
  ok('affiliates page: debounced q, nextCursor "عرض المزيد", gate, mergeById, total, imports recruiterVisibility',
    /DEBOUNCE_MS/.test(aff) && /عرض المزيد/.test(aff) && /gate\.isCurrent\(token\)/.test(aff) && /mergeById\(l\.items, items\)/.test(aff) && /data-total/.test(aff)
    && /from "@\/lib\/recruiterVisibility"/.test(aff));

  for (const f of ['src/app/recruiter/network/page.jsx', 'src/app/recruiter/network/stats/page.jsx', 'src/app/recruiter/affiliates/page.jsx']) {
    const code = src[f];
    const creates = [...code.matchAll(/href="\/recruiter\/affiliates\/new"/g)].map((m) => code.slice(Math.max(0, m.index - 220), m.index));
    ok(`${f}: every creation link (incl. the empty state) is behind canCreate (from /api/recruiter/me)`, creates.length >= 1 && creates.every((ctx) => /canCreate &&/.test(ctx)) && /useRecruiterPerms\(/.test(code), String(creates.length));
  }
  const hub = src['src/app/recruiter/page.jsx'];
  ok('hub: one entry per page (no duplicate /recruiter/network), affiliates list linked, activity log stays "قريباً"',
    (hub.match(/href: "\/recruiter\/network"/g) || []).length === 1 && /href: "\/recruiter\/affiliates"/.test(hub) && /data-affiliates-link/.test(hub)
    && /\{ id: "log", label: "سجل العمليات", Icon: History \}/.test(hub) && /قريباً/.test(hub));
  ok('hub: progress summary from /api/recruiter/progress (group q / size, awarded / reversed, gross / net, "غير مفعّلة"), KYC card from /api/recruiter/identity',
    /\/api\/recruiter\/progress/.test(hub) && /toRecruiterProgressSummaryView/.test(hub) && /data-group-progress/.test(hub) && /data-gross/.test(hub) && /data-net/.test(hub)
    && /غير مفعّلة/.test(hub) && /\/api\/recruiter\/identity/.test(hub) && /data-kyc-card/.test(hub));
  ok('hub: creation entries need an explicit canCreateAffiliates === true', /const canCreate = perms\?\.canCreateAffiliates === true;/.test(hub) && /canCreateAffiliates !== true/.test(hub));

  const wallet = src['src/app/recruiter/wallet/page.jsx'];
  ok('wallet: gross / reversed / net apart (from /api/recruiter/progress), group rows labelled with cycle and size',
    /\/api\/recruiter\/progress/.test(wallet) && /data-gross-total/.test(wallet) && /data-reversed-total/.test(wallet) && /data-net-total/.test(wallet)
    && /rewardRowTitle\(r\)/.test(wallet) && /groupRowDetail\(r\)/.test(wallet));
  ok('wallet: a failed KYC request → "حالة التحقق غير متاحة" + retry, never "not verified"; a known non-approved status still shows its banner',
    /حالة التحقق غير متاحة/.test(wallet) && /data-identity-retry/.test(wallet) && /\{identity && !identityApproved && \(/.test(wallet) && !/KYC unknown \(request failed\) → shown as not approved/.test(read('src/app/recruiter/wallet/page.jsx')));
  ok('wallet: negative-balance banner and bank gate unchanged', /\{available < 0 && \(/.test(wallet) && /data-bank-required/.test(wallet) && /\{bankComplete && available === 0 && \(/.test(wallet));

  const ver = read('src/app/recruiter/verification/page.jsx');
  ok('verification: the submit error is rendered OUTSIDE the form (visible after IDENTITY_SUBMISSION_NOT_ALLOWED hides it)',
    ver.indexOf('data-identity-error') > ver.lastIndexOf('</form>') && ver.lastIndexOf('</form>') > 0);
  const pw = src['src/app/recruiter/password/page.jsx'];
  ok('password: synchronous double-submit guard (busyRef)', /if \(busy \|\| busyRef\.current\) return;/.test(pw) && /busyRef\.current = true;/.test(pw) && /busyRef\.current = false;/.test(pw));
  const labels = read('src/app/recruiter/errorLabels.js');
  ok('rate-limit label is neutral ("حاول لاحقاً"), no fixed delay promised', labels.includes('RATE_LIMITED: "محاولات كثيرة، حاول لاحقاً."') && !labels.includes('حاول بعد دقيقة'));
  const stats = read('src/app/recruiter/network/stats/page.jsx');
  ok('levels: one absolute convention (tree and stats use levelLabel; no "relative to the sub-network" wording)',
    /levelLabel\(l\.level\)/.test(stats) && /levelLabel\(node\.level\)/.test(net) && !stats.includes('1 = المباشرون تحت هذا الحساب'));
  ok('pure helper modules import nothing (no fetch, no React, no "@/" alias)', !/^import /m.test(read('src/app/recruiter/recruiterUiState.js')) && !/^import /m.test(read('src/app/recruiter/wallet/walletUi.js'))
    && !/fetch\(/.test(stripJs(read('src/app/recruiter/recruiterUiState.js'))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
