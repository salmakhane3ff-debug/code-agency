#!/usr/bin/env node
/**
 * scripts/adminOrdersPagination.test.mjs — Phase 3: server-side pagination of the Admin Store Orders
 * list (/admin/orders → GET /api/admin/orders). GET /api/order stays the complete array.
 *
 *   1. Query rules: page sizes exactly 10 / 100 (default 10), page, search, status, source, sort.
 *   2. Service over an in-memory fake whose queries follow the SQL contract: page sizes, Next / Previous,
 *      first / last page, clamping, totals, ties, every order exactly once — and the union of the pages
 *      equals what the OLD page computed in the browser (its filter + sort, copied verbatim below).
 *   3. Route handler: 200 shape, 400 on invalid parameters, 500 on a DB error, no-store.
 *   4. Static: the page fetches one page from the new endpoint, keeps the same status update
 *      (PUT /api/order), and every other order surface is untouched.
 * The SQL itself is additionally run on a disposable PostgreSQL during verification.
 * Run: node scripts/adminOrdersPagination.test.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseAdminOrdersQuery, orderPageCount, clampOrderPage, adminOrdersQueryString, ORDER_PAGE_SIZES, DEFAULT_ORDER_PAGE_SIZE, ORDER_STATUSES,
} from '../src/lib/adminOrdersQuery.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const S = await import('../src/lib/services/adminOrdersListService.js');
const { mapOrder } = await import('../src/lib/utils/mappers.js');
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const throwsField = (fn) => { try { fn(); return null; } catch (e) { return e.code === 'INVALID_INPUT' ? e.field : `other:${e.message}`; } };

// ── 1. Query rules ────────────────────────────────────────────────────────────
console.log('1. Query rules');
{
  const d = parseAdminOrdersQuery(new URLSearchParams(''));
  ok('defaults: page 1, 10 per page, no search, all statuses, all sources, newest first',
    JSON.stringify(d) === JSON.stringify({ page: 1, pageSize: 10, q: null, status: null, source: 'ALL', sort: 'desc' }) && DEFAULT_ORDER_PAGE_SIZE === 10);
  ok('page sizes: exactly 10 and 100', JSON.stringify(ORDER_PAGE_SIZES) === '[10,100]'
    && parseAdminOrdersQuery({ pageSize: '100' }).pageSize === 100 && parseAdminOrdersQuery({ pageSize: '10' }).pageSize === 10);
  ok('any other page size → 400 field pageSize', ['20', '0', '50', '1000', 'abc', '10.5', '-10', '010', ' 1 0'].every((v) => throwsField(() => parseAdminOrdersQuery({ pageSize: v })) === 'pageSize'));
  ok('page: positive integer; invalid → 400', parseAdminOrdersQuery({ page: '7' }).page === 7
    && ['0', '-1', '1.5', 'x', '01', '99999999'].every((v) => throwsField(() => parseAdminOrdersQuery({ page: v })) === 'page'));
  ok('status: ALL or one of the 5 page statuses (empty = ALL); anything else → 400',
    ORDER_STATUSES.every((s) => parseAdminOrdersQuery({ status: s }).status === s) && parseAdminOrdersQuery({ status: 'ALL' }).status === null
    && ['PENDING', 'new', 'X'].every((v) => throwsField(() => parseAdminOrdersQuery({ status: v })) === 'status'));
  ok('source ALL / REAL / FAKE; sort desc / asc; others → 400', parseAdminOrdersQuery({ source: 'FAKE', sort: 'asc' }).source === 'FAKE'
    && throwsField(() => parseAdminOrdersQuery({ source: 'fake' })) === 'source' && throwsField(() => parseAdminOrdersQuery({ sort: 'up' })) === 'sort');
  ok('search: trimmed + lower-cased (like the old page); too long → 400', parseAdminOrdersQuery({ q: '  AbC 06 ' }).q === 'abc 06'
    && parseAdminOrdersQuery({ q: '   ' }).q === null && throwsField(() => parseAdminOrdersQuery({ q: 'x'.repeat(201) })) === 'q');
  ok('page count: at least 1; exact multiples; partial last page', orderPageCount(0, 10) === 1 && orderPageCount(10, 10) === 1 && orderPageCount(11, 10) === 2 && orderPageCount(250, 100) === 3);
  ok('clamp: page past the end → last page; below 1 → 1', clampOrderPage(9, 25, 10) === 3 && clampOrderPage(0, 25, 10) === 1 && clampOrderPage(5, 0, 10) === 1);
  ok('query string (page, size, filters; defaults omitted)', adminOrdersQueryString({ page: 2, pageSize: 100, q: ' x ', status: 'NEW', source: 'FAKE', sort: 'asc' })
    === 'page=2&pageSize=100&q=x&status=NEW&source=FAKE&sort=asc' && adminOrdersQueryString({}) === 'page=1&pageSize=10');
}

// ── Fake DB following the SQL contract ($1 q · $2 status · $3 isFake · $4 limit · $5 offset) ──
const truthy = (v) => (v === null || v === undefined ? false : typeof v === 'object' ? true : Boolean(v));
const isDraftRow = (r) => (r.paymentDetails && typeof r.paymentDetails === 'object' && !Array.isArray(r.paymentDetails) ? truthy(r.paymentDetails.isDraft) : false);
function sqlMatch(r, q, status, fake) {
  if (isDraftRow(r)) return false;
  if (q !== null && !((r.customerPhone ?? '').includes(q) || r.customerName.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))) return false;
  if (status !== null && (r.status ? r.status.toUpperCase() : 'NEW') !== status) return false;
  if (fake !== null && r.isFake !== fake) return false;
  return true;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function makeFakeDb(rows, { failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql, ...p) {
      calls.push({ sql, p });
      if (failOn === 'query') throw new Error('db down');
      if (sql === S.ADMIN_ORDERS_OVERALL_SQL) return [{ total: rows.length }];
      const [q, status, fake, limit, offset] = p;
      const hits = rows.filter((r) => sqlMatch(r, q, status, fake));
      if (sql === S.ADMIN_ORDERS_COUNT_SQL) return [{ total: hits.length }];
      const dir = sql === S.ADMIN_ORDERS_PAGE_SQL.asc ? 1 : sql === S.ADMIN_ORDERS_PAGE_SQL.desc ? -1 : 0;
      if (!dir) throw new Error('unexpected SQL');
      return hits.sort((a, b) => dir * (cmp(+a.createdAt, +b.createdAt) || cmp(a.id, b.id))).slice(offset, offset + limit).map((r) => ({ id: r.id }));
    },
    order: {
      async findMany({ where, include }) {
        calls.push({ findMany: where.id.in.length, include });
        return rows.filter((r) => where.id.in.includes(r.id)).reverse(); // any order: the service must re-sort
      },
    },
  };
}

// The OLD page's in-browser list (copied verbatim from src/app/admin/orders/page.jsx before this phase).
function normaliseStatus(s) { if (!s) return 'NEW'; return s.toUpperCase(); }
function oldDisplayed(orders, search, statusFilter, sourceFilter, sortDesc) {
  let list = [...orders];
  list = list.filter((o) => !o.paymentDetails?.isDraft);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((o) => o.phone?.includes(q) || o.name?.toLowerCase().includes(q) || o._id?.toLowerCase().includes(q));
  }
  if (statusFilter !== 'ALL') list = list.filter((o) => normaliseStatus(o.status) === statusFilter);
  if (sourceFilter === 'REAL') list = list.filter((o) => !o.isFake);
  else if (sourceFilter === 'FAKE') list = list.filter((o) => o.isFake);
  list.sort((a, b) => { const diff = new Date(b.createdAt) - new Date(a.createdAt); return sortDesc ? diff : -diff; });
  return list;
}

// Data: 237 orders, shared timestamps, drafts (true / "yes" / 0 / false), lower + upper statuses, fake / real.
let seed = 3;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const NAMES = ['Salma Idrissi', 'Youssef Amrani', 'Karim Benali', 'Nadia El Fassi', 'Omar Tazi', 'سارة العلوي'];
const STATUS_POOL = ['pending', 'NEW', 'CONFIRMED', 'confirmed', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'success', ''];
const ROWS = Array.from({ length: 237 }, (_, n) => ({
  id: `${(Math.floor(rnd() * 0xffffff)).toString(16).padStart(6, '0')}-ord-${String(n).padStart(4, '0')}`,
  customerName: `${NAMES[n % NAMES.length]} ${n}`,
  customerEmail: `c${n}@example.test`,
  customerPhone: n % 13 === 0 ? null : `06${String(10000000 + Math.floor(rnd() * 89999999))}`,
  status: STATUS_POOL[n % STATUS_POOL.length],
  isFake: n % 4 === 0,
  createdAt: new Date(Date.UTC(2026, 9, 1) + Math.floor(rnd() * 60) * 60_000), // many equal createdAt
  paymentDetails: n % 11 === 0 ? { isDraft: true, total: 10 } : n % 23 === 0 ? { isDraft: 'yes' } : n % 29 === 0 ? { isDraft: 0, total: 5 } : n % 31 === 0 ? null : { total: 100 + n },
  shippingAddress: { address: { city: 'Casablanca' } },
  items: [],
}));
const MAPPED = ROWS.map(mapOrder);

async function walk(db, query) {
  const first = await S.listAdminOrdersPage({ ...query, page: 1 }, { db });
  const ids = first.items.map((o) => o._id);
  let page = first, guard = 0;
  while (page.page < page.pages && guard++ < 10_000) {
    page = await S.listAdminOrdersPage({ ...query, page: page.page + 1 }, { db });
    ids.push(...page.items.map((o) => o._id));
  }
  return { first, ids, last: page };
}

// ── 2. Service ────────────────────────────────────────────────────────────────
console.log('\n2. Service — pages, boundaries, filters, totals, ties');
{
  const db = makeFakeDb(ROWS);
  const base = { q: null, status: null, source: 'ALL', sort: 'desc' };
  const p1 = await S.listAdminOrdersPage({ ...base, page: 1, pageSize: 10 }, { db });
  const expectAll = oldDisplayed(MAPPED, '', 'ALL', 'ALL', true);
  ok('page size 10: 10 items, total = matching (drafts hidden), overall = every order (old header counters)',
    p1.items.length === 10 && p1.total === expectAll.length && p1.overall === ROWS.length && p1.pages === Math.ceil(expectAll.length / 10) && p1.page === 1 && p1.pageSize === 10);
  const p100 = await S.listAdminOrdersPage({ ...base, page: 1, pageSize: 100 }, { db });
  ok('page size 100: 100 items, same first 10 as page size 10', p100.items.length === 100 && JSON.stringify(p100.items.slice(0, 10).map((o) => o._id)) === JSON.stringify(p1.items.map((o) => o._id)));
  const p2 = await S.listAdminOrdersPage({ ...base, page: 2, pageSize: 10 }, { db });
  const back = await S.listAdminOrdersPage({ ...base, page: 1, pageSize: 10 }, { db });
  ok('Next then Previous: page 2 continues page 1, coming back gives page 1 again', JSON.stringify(p2.items.map((o) => o._id)) === JSON.stringify(p100.items.slice(10, 20).map((o) => o._id))
    && JSON.stringify(back.items.map((o) => o._id)) === JSON.stringify(p1.items.map((o) => o._id)));
  const lastNo = p1.pages;
  const last = await S.listAdminOrdersPage({ ...base, page: lastNo, pageSize: 10 }, { db });
  ok('last page: the remainder, page = pages', last.page === lastNo && last.items.length === p1.total - (lastNo - 1) * 10 && last.items.length > 0);
  const past = await S.listAdminOrdersPage({ ...base, page: lastNo + 5, pageSize: 10 }, { db });
  ok('past the end → the last page is served (page clamped)', past.page === lastNo && JSON.stringify(past.items.map((o) => o._id)) === JSON.stringify(last.items.map((o) => o._id)));
  ok('items have exactly the GET /api/order item shape (mapOrder)', JSON.stringify(Object.keys(p1.items[0]).sort()) === JSON.stringify(Object.keys(mapOrder(ROWS[0])).sort()));
  const fm = db.calls.filter((c) => c.findMany);
  ok('only the requested page is loaded (findMany ≤ pageSize ids, with items)', fm.every((c) => c.findMany <= 100) && fm.every((c) => c.include?.items === true));

  const COMBOS = [
    ['', 'ALL', 'ALL', true], ['', 'ALL', 'ALL', false], ['', 'NEW', 'ALL', true], ['', 'CONFIRMED', 'REAL', true], ['', 'ALL', 'FAKE', false],
    ['salma', 'ALL', 'ALL', true], ['  KARIM ', 'CANCELLED', 'ALL', true], ['06', 'SHIPPED', 'FAKE', true], ['ord-01', 'ALL', 'REAL', false],
    ['سارة', 'ALL', 'ALL', true], ['%', 'ALL', 'ALL', true], ['zzz-none', 'ALL', 'ALL', true],
  ];
  for (const [search, status, source, desc] of COMBOS) {
    const expected = oldDisplayed(MAPPED, search, status, source, desc).map((o) => o._id);
    for (const pageSize of [10, 100]) {
      const query = { ...parseAdminOrdersQuery({ q: search, status, source, sort: desc ? 'desc' : 'asc' }), pageSize };
      const w = await walk(db, query);
      // Same set as the old page; within equal createdAt the server order is deterministic (id), the old one was not.
      const sameSet = JSON.stringify([...w.ids].sort()) === JSON.stringify([...expected].sort());
      const sameTimeOrder = w.ids.every((id, k) => k === 0 || (desc ? 1 : -1) * (+MAPPED.find((o) => o._id === w.ids[k - 1]).createdAt - +MAPPED.find((o) => o._id === id).createdAt) >= 0);
      ok(`"${search}" / ${status} / ${source} / ${desc ? 'newest' : 'oldest'} first, ${pageSize}/page: = old page list, each order once (${expected.length})`,
        sameSet && w.ids.length === expected.length && new Set(w.ids).size === w.ids.length && w.first.total === expected.length && sameTimeOrder);
    }
  }
  // Ties: equal createdAt → id order in the sort direction, identical on every call.
  const tied = Array.from({ length: 25 }, (_, n) => ({ ...ROWS[1], id: `tie-${String(n).padStart(2, '0')}`, createdAt: new Date(Date.UTC(2026, 0, 1)), paymentDetails: {} }));
  const tdb = makeFakeDb(tied);
  const wd = await walk(tdb, { ...base, pageSize: 10 });
  const wa = await walk(tdb, { ...base, sort: 'asc', pageSize: 10 });
  ok('25 orders with the SAME createdAt: stable id order (desc / asc), 3 pages, none repeated or missing',
    JSON.stringify(wd.ids) === JSON.stringify(tied.map((o) => o.id).sort().reverse()) && JSON.stringify(wa.ids) === JSON.stringify(tied.map((o) => o.id).sort()) && wd.first.pages === 3);
  const empty = await S.listAdminOrdersPage({ ...base, q: 'nothing-matches', page: 1, pageSize: 10 }, { db });
  ok('no match: empty page 1 of 1, total 0, overall unchanged, no page query', empty.items.length === 0 && empty.total === 0 && empty.pages === 1 && empty.page === 1 && empty.overall === ROWS.length);
  ok('drafts: true / "yes" hidden; 0 / null / missing kept (same as !paymentDetails?.isDraft)',
    !expectAll.some((o) => o.paymentDetails?.isDraft) && MAPPED.some((o) => o.paymentDetails?.isDraft === 0) && expectAll.some((o) => o.paymentDetails?.isDraft === 0));
  ok('status semantics unchanged: "pending" orders only under ALL (shown as PENDING), empty status counts as NEW',
    oldDisplayed(MAPPED, '', 'NEW', 'ALL', true).every((o) => !o.status || o.status.toUpperCase() === 'NEW')
    && (await walk(db, { ...base, status: 'NEW', pageSize: 100 })).ids.every((id) => { const r = ROWS.find((x) => x.id === id); return r.status === '' || r.status === 'NEW'; }));
}

// ── 3. Route handler ──────────────────────────────────────────────────────────
console.log('\n3. GET /api/admin/orders handler');
{
  const h = S.adminOrdersHandlers({ db: makeFakeDb(ROWS) });
  const res = await h.list(new Request('http://x/api/admin/orders?page=2&pageSize=100&status=CONFIRMED&source=REAL&q=a'));
  const body = await res.json();
  ok('200 + { items, total, overall, page, pageSize, pages } + no-store', res.status === 200 && res.headers.get('cache-control') === 'no-store'
    && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['items', 'overall', 'page', 'pageSize', 'pages', 'total']));
  const bad = await S.adminOrdersHandlers({ db: makeFakeDb(ROWS) }).list(new Request('http://x/api/admin/orders?pageSize=25'));
  const bb = await bad.json();
  ok('invalid page size → 400 INVALID_INPUT (field pageSize), nothing queried', bad.status === 400 && bb.code === 'INVALID_INPUT' && bb.field === 'pageSize');
  const err = await S.adminOrdersHandlers({ db: makeFakeDb(ROWS, { failOn: 'query' }) }).list(new Request('http://x/api/admin/orders'));
  ok('DB error → 500 SERVER_ERROR (no internals leaked)', err.status === 500 && (await err.json()).code === 'SERVER_ERROR');
  const route = read('src/app/api/admin/orders/route.js');
  ok('route: GET only, admin-only (withAdminAuth)', /export const GET = withAdminAuth\(h\.list\);/.test(route) && !/export const (POST|PUT|PATCH|DELETE)/.test(route));
}

// ── 4. Static: page + untouched surfaces ──────────────────────────────────────
console.log('\n4. Admin page wiring and unchanged surfaces');
{
  const page = read('src/app/admin/orders/page.jsx');
  ok('the page fetches ONE page from /api/admin/orders (no full /api/order list fetch)', /fetch\(`\/api\/admin\/orders\?\$\{qs\}`/.test(page) && !/fetch\("\/api\/order"\)\s*\n?\s*\.then/.test(page)
    && (page.match(/fetch\("\/api\/order"/g) || []).length === 1);
  ok('no client-side filtering / sorting / slicing of the order list any more', !/useMemo/.test(page) && !/list\.sort|orders\.filter|\.slice\(\(page/.test(page));
  ok('status update unchanged: PUT /api/order { id, status } (then the page refreshes)', /method:\s+"PUT",[\s\S]{0,120}body:\s+JSON\.stringify\(\{ id: orderId, status: newStatus \}\)/.test(page)
    && /setReloadKey\(\(k\) => k \+ 1\)/.test(page));
  ok('page size select = 10 / 100 (default 10); filters, search, size and sort reset to page 1',
    /ORDER_PAGE_SIZES\.map\(\(n\) => <option key=\{n\} value=\{n\}>\{n\}<\/option>\)/.test(page) && /useState\(DEFAULT_ORDER_PAGE_SIZE\)/.test(page)
    && /const changeStatus   = \(v\) => \{ setStatusFilter\(v\); setPage\(1\); \};/.test(page) && /const changeSource   = \(v\) => \{ setSourceFilter\(v\); setPage\(1\); \};/.test(page)
    && /const changePageSize = \(v\) => \{ setPageSize\(Number\(v\)\); setPage\(1\); \};/.test(page) && /const toggleSort     = \(\) => \{ setSortDesc\(\(d\) => !d\); setPage\(1\); \};/.test(page)
    && /setQuery\(search\.trim\(\)\); setPage\(1\);/.test(page));
  ok('Previous / Next disabled at the boundaries; current page, total pages and total matching shown',
    /disabled=\{meta\.page <= 1 \|\| fetching\}/.test(page) && /disabled=\{meta\.page >= meta\.pages \|\| fetching\}/.test(page)
    && /الصفحة \{meta\.page\} من \{meta\.pages\}/.test(page) && /\{meta\.total\} طلب مطابق/.test(page) && /\{meta\.total\} من \{meta\.overall\} طلب/.test(page));
  ok('the wide table scrolls inside its box (page root contained like the other admin pages) — header, filters, pagination stay on screen',
    /<div className="py-6 space-y-5 max-w-7xl min-w-0 \[contain:inline-size\]">/.test(page) && /<div className="overflow-x-auto">/.test(page));
  ok('order details link + copy link + status dropdown kept', /router\.push\(`\/admin\/orders\/\$\{order\._id\}`\)/.test(page) && /<CopyLink orderId=\{order\._id\} \/>/.test(page) && /<StatusDropdown/.test(page));
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const UNTOUCHED = [
    'src/app/api/order/route.jsx', 'src/lib/controllers/orderController.js', 'src/lib/services/orderService.js', 'src/lib/utils/mappers.js',
    'src/app/admin/page.jsx', 'src/app/admin/payment/page.jsx', 'src/app/admin/analytics/page.jsx', 'src/app/admin/orders/[id]/page.jsx', 'src/app/track-order/page.jsx',
    // out of scope: affiliate orders (admin + affiliate dashboard), recruiter
    'src/app/admin/affiliate-orders/page.jsx', 'src/app/api/admin/affiliate-orders', 'src/app/api/affiliate/orders', 'src/lib/services/affiliateSystemService.js',
    'src/lib/services/recruiterNetworkService.js', 'src/app/recruiter',
  ];
  // Phase 4 (bank logo picker, approved): its bank-details edits of affiliateSystemService.js (line-pinned) and the recruiter wallet /
  // error-label files are set aside (exact list + pins in scripts/lib/payoutBanksAllowance.mjs); no order code is among them.
  const { isPayoutBankSrc } = await import('./lib/payoutBanksAllowance.mjs');
  const changed = git(['diff', '--name-only', 'HEAD', '--', ...UNTOUCHED]).split('\n').filter((f) => f && !isPayoutBankSrc(f)).join('\n');
  ok('GET /api/order, its controller / service / mapper, its 5 other consumers, affiliate & recruiter orders: unchanged', changed === '', changed);
  ok('GET /api/order still returns the plain array of every order (controller unchanged)',
    /const orders = await getAllOrders\(\);\s*\n\s*return Response\.json\(orders\);/.test(read('src/lib/controllers/orderController.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
