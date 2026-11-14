#!/usr/bin/env node
/**
 * scripts/productFeedOrder.test.mjs — Phase 2: /products lists AVAILABLE products before LOCKED ones.
 *
 *   1. Cursor codec: (isLocked, createdAt, id) keyset; old { t, i } cursors read as "available group";
 *      an invalid lock flag → first page.
 *   2. The SQL (static): ORDER BY "isLocked" ASC, "createdAt" DESC, id DESC + the matching three-part
 *      keyset, the lock flag bound as $6; filters, COUNT, columns and the lock trimming unchanged.
 *   3. Page walks over a reference model of that SQL (same predicate, same order) with the REAL cursor
 *      codec and the REAL feedReducer: every page size, no filter / collection / search / both —
 *      available before locked, newest first in each group, every matching product exactly once.
 *   4. Old cursors issued in the previous order: continuing from any of them misses nothing and the
 *      reducer drops the few repeats.
 *   5. Product Lock enforcement, the homepage grid and the client feed are unchanged.
 * Pure Node (no database). The real SQL is additionally exercised on a disposable PostgreSQL
 * during verification (not part of this file).
 * Run: node scripts/productFeedOrder.test.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeCursor, decodeCursor, feedReducer, initialFeedState, filterSignature } from '../src/lib/productFeed.js';
import { searchParam } from '../src/lib/productSearch.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SERVICE = read('src/lib/services/productService.js');

// ── 1. Cursor codec ───────────────────────────────────────────────────────────
console.log('1. Cursor codec');
{
  const at = new Date('2026-05-01T10:20:30.400Z');
  const u = decodeCursor(encodeCursor({ id: 'p-1', createdAt: at, isLocked: false }));
  const l = decodeCursor(encodeCursor({ id: 'p-2', createdAt: at, isLocked: true }));
  ok('round-trips the three keyset parts (available row)', u && u.id === 'p-1' && u.createdAt === at.toISOString() && u.locked === false);
  ok('round-trips the three keyset parts (locked row)', l && l.id === 'p-2' && l.locked === true);
  ok('a row without isLocked encodes as available (l: 0)', decodeCursor(encodeCursor({ id: 'x', createdAt: at })).locked === false);
  ok('still opaque base64 JSON {l,t,i}', JSON.stringify(JSON.parse(atob(encodeCursor({ id: 'x', createdAt: at, isLocked: true })))) === JSON.stringify({ l: 1, t: at.toISOString(), i: 'x' }));
  const legacy = btoa(JSON.stringify({ t: at.toISOString(), i: 'old' }));
  const lg = decodeCursor(legacy);
  ok('old cursor {t,i} (previous order) is accepted, read as the available group', lg && lg.id === 'old' && lg.createdAt === at.toISOString() && lg.locked === false);
  ok('invalid lock flag → null (first page, never an error)', [2, -1, '1', '0', true, false, null, 0.5, {}].every((v) => decodeCursor(btoa(JSON.stringify({ l: v, t: at.toISOString(), i: 'x' }))) === null));
  ok('garbage / wrong shape / bad date / empty → null', decodeCursor('!!!') === null && decodeCursor(btoa('{"nope":1}')) === null
    && decodeCursor(btoa(JSON.stringify({ l: 0, t: 'not-a-date', i: 'x' }))) === null && decodeCursor('') === null && decodeCursor(null) === null);
  ok('incomplete row → no cursor', encodeCursor({ id: 'x' }) === null && encodeCursor(null) === null);
}

// ── 2. SQL (static) ───────────────────────────────────────────────────────────
console.log('\n2. Feed SQL');
const FEED_SQL = (SERVICE.match(/const FEED_SQL = `([\s\S]*?)`;/) || [])[1] || '';
{
  ok('order: available first, then locked; newest first inside each group', /ORDER BY "isLocked" ASC, "createdAt" DESC, id DESC\s*\n\s*LIMIT \$5::int/.test(FEED_SQL));
  ok('keyset = exactly the rows after the cursor in that order',
    /AND \(\$3::timestamp\(3\) IS NULL\s*\n\s*OR "isLocked" > \$6::boolean\s*\n\s*OR \("isLocked" = \$6::boolean AND \("createdAt", id\) < \(\$3::timestamp\(3\), \$4::text\)\)\)/.test(FEED_SQL));
  ok('the lock flag is bound LAST ($6), after the unchanged $1…$5', /size \+ 1,\s*\n\s*key \? key\.locked : false,\s*\n\s*\),/.test(SERVICE)
    && /FEED_SQL,\s*\n\s*collectionParam,\s*\n\s*searchTokens,\s*\n\s*key \? new Date\(key\.createdAt\) : null,\s*\n\s*key \? key\.id : null,/.test(SERVICE));
  ok('statement stays static (no interpolation besides the shared column / where blocks)', (FEED_SQL.match(/\$\{/g) || []).length === 2 && /\$\{FEED_COLUMNS\}/.test(FEED_SQL) && /\$\{FEED_WHERE\}/.test(FEED_SQL));
  ok('filters, COUNT and columns unchanged (total = all matching products, both groups)',
    /const FEED_COUNT_SQL = `SELECT count\(\*\)::int AS total FROM products \$\{FEED_WHERE\}`;/.test(SERVICE)
    && /WHERE status = 'Active'/.test(SERVICE) && /bundles, "isLocked", "createdAt"`/.test(SERVICE));
  ok('locked rows are still trimmed for the public feed', /items:      page\.map\(\(p\) => publicListProduct\(p, storeSettings\)\)/.test(SERVICE)
    && /nextCursor: hasMore && page\.length \? encodeCursor\(page\[page\.length - 1\]\) : null,/.test(SERVICE));
}

// ── Reference model of FEED_SQL (same predicate, same order) ──────────────────
const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
const orderNew = (a, b) => (Number(a.isLocked) - Number(b.isLocked)) || cmpDesc(+a.createdAt, +b.createdAt) || cmpDesc(a.id, b.id);
const orderOld = (a, b) => cmpDesc(+a.createdAt, +b.createdAt) || cmpDesc(a.id, b.id);
const rowLt = (a, t, i) => +a.createdAt < t || (+a.createdAt === t && a.id < i); // ("createdAt", id) < (T, I)
function matches(p, collection, tokens) {
  if (p.status !== 'Active') return false;
  if (collection && !(Array.isArray(p.collections) && p.collections.some((c) => c.toLowerCase() === collection.toLowerCase()))) return false;
  if (tokens) {
    const hay = [p.title, p.shortDescription, p.description].filter((x) => x != null).join(' ').toLowerCase();
    if (!tokens.split('\u0001').every((tok) => hay.includes(tok.toLowerCase()))) return false;
  }
  return true;
}
// $1 collection, $2 tokens, $3 createdAt, $4 id, $5 limit, $6 locked — mirrors FEED_SQL.
function feedSql(catalogue, $1, $2, $3, $4, $5, $6) {
  return catalogue.filter((p) => matches(p, $1, $2))
    .filter((p) => $3 === null || Number(p.isLocked) > Number($6) || (p.isLocked === $6 && rowLt(p, +$3, $4)))
    .sort(orderNew).slice(0, $5);
}
// Mirrors getProductsPage around the query (decode → query → hasMore → encode).
function getPage(catalogue, { cursor = null, size = 16, collection = null, q = null }) {
  const key = decodeCursor(cursor);
  const rows = feedSql(catalogue, collection, searchParam(q), key ? new Date(key.createdAt) : null, key ? key.id : null, size + 1, key ? key.locked : false);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  return { items: page.map((p) => ({ _id: p.id, isLocked: p.isLocked })), nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null, hasMore };
}
// Walk every page through the real reducer, as the client does.
function walk(catalogue, opts, start = null, state0 = null) {
  const signature = filterSignature(opts);
  let state = state0 || initialFeedState({ signature, hasMore: true });
  let cursor = start, pages = 0, raw = [];
  for (;;) {
    const r = getPage(catalogue, { ...opts, cursor });
    raw = raw.concat(r.items.map((x) => x._id));
    state = feedReducer(state, { type: 'LOAD_SUCCESS', signature, items: r.items, nextCursor: r.nextCursor, hasMore: r.hasMore });
    pages++;
    if (!r.hasMore) break;
    cursor = r.nextCursor;
    if (pages > 10_000) throw new Error('runaway');
  }
  return { ids: state.items.map((x) => x._id), raw, pages };
}

// Catalogue: interleaved locks, shared timestamps (id tie-break, across both groups), collections, text, inactive rows.
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const WORDS = ['apple', 'iphone', 'samsung', 'galaxy', 'casque', 'montre', 'sport', 'gold', 'case', 'pro'];
const CATALOGUE = Array.from({ length: 140 }, (_, n) => {
  const t = Date.UTC(2026, 0, 1) + Math.floor(rnd() * 40) * 3_600_000; // many equal createdAt values
  return {
    id: `p${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}-${n}`,
    createdAt: new Date(t),
    isLocked: rnd() < 0.35,
    status: n % 17 === 0 ? 'Inactive' : 'Active',
    collections: n % 9 === 0 ? 'not-an-array' : [rnd() < 0.5 ? 'Smartphones' : 'Accessoires', ...(rnd() < 0.3 ? ['Promo'] : [])],
    title: `${WORDS[n % WORDS.length]} ${WORDS[(n * 3) % WORDS.length]} ${n}`,
    shortDescription: rnd() < 0.5 ? `${WORDS[(n * 7) % WORDS.length]} edition` : null,
    description: n % 5 === 0 ? 'Apple iPhone compatible' : '',
  };
});

// ── 3. Page walks ─────────────────────────────────────────────────────────────
console.log('\n3. Page walks (reference model of the SQL, real cursor + reducer)');
{
  const FILTERS = [
    { label: 'no filter' }, { label: 'collection', collection: 'smartphones' }, { label: 'search', q: 'apple iphone' },
    { label: 'collection + search', collection: 'Promo', q: 'gold' }, { label: 'search one word', q: 'casque' },
  ];
  for (const f of FILTERS) {
    const opts = { collection: f.collection ?? null, q: f.q ?? null };
    const expected = CATALOGUE.filter((p) => matches(p, opts.collection, searchParam(opts.q))).sort(orderNew).map((p) => p.id);
    for (const size of [1, 3, 7, 16, 48]) {
      const { ids, raw, pages } = walk(CATALOGUE, { ...opts, size });
      const byId = new Map(CATALOGUE.map((p) => [p.id, p]));
      const firstLocked = ids.findIndex((id) => byId.get(id).isLocked);
      const groupsOk = firstLocked === -1 || ids.slice(firstLocked).every((id) => byId.get(id).isLocked);
      const newestFirst = ids.every((id, k) => k === 0 || byId.get(ids[k - 1]).isLocked !== byId.get(id).isLocked || orderNew(byId.get(ids[k - 1]), byId.get(id)) < 0);
      ok(`${f.label}, ${size}/page: every match exactly once, available → locked, newest first in each group (${expected.length} products, ${pages} pages)`,
        JSON.stringify(ids) === JSON.stringify(expected) && raw.length === expected.length && new Set(raw).size === raw.length && groupsOk && newestFirst
        && pages === Math.max(1, Math.ceil(expected.length / size)));
    }
  }
  const all = CATALOGUE.filter((p) => matches(p, null, null));
  ok('the catalogue really mixes both groups, shared timestamps and filters', all.some((p) => p.isLocked) && all.some((p) => !p.isLocked)
    && new Set(all.map((p) => +p.createdAt)).size < all.length);
  const edge = [{ id: 'a', createdAt: new Date(1000), isLocked: true, status: 'Active', collections: [], title: 'x' }];
  ok('only locked products / only available / empty list', JSON.stringify(walk(edge, { size: 1 }).ids) === '["a"]'
    && JSON.stringify(walk(edge.map((p) => ({ ...p, isLocked: false })), { size: 2 }).ids) === '["a"]' && walk([], { size: 3 }).ids.length === 0);
}

// ── 4. Old cursors (previous order) ───────────────────────────────────────────
console.log('\n4. Continuing from an old cursor (issued in the previous createdAt order)');
{
  const opts = { collection: null, q: null };
  const active = CATALOGUE.filter((p) => matches(p, null, null));
  const oldOrder = [...active].sort(orderOld);
  let allComplete = true, maxRepeats = 0, checked = 0;
  for (const size of [3, 16]) {
    for (let pagesSeen = 1; pagesSeen * size < oldOrder.length; pagesSeen += 2) {
      const seen = oldOrder.slice(0, pagesSeen * size);                      // what the visitor already has
      const last = seen[seen.length - 1];
      const legacyCursor = btoa(JSON.stringify({ t: last.createdAt.toISOString(), i: last.id }));
      let state = initialFeedState({ items: seen.map((p) => ({ _id: p.id })), signature: filterSignature(opts), hasMore: true });
      const r = walk(CATALOGUE, { ...opts, size }, legacyCursor, state);
      const final = new Set(r.ids);
      const complete = final.size === active.length && active.every((p) => final.has(p.id)) && r.ids.length === new Set(r.ids).size;
      allComplete &&= complete;
      maxRepeats = Math.max(maxRepeats, r.raw.filter((id) => seen.some((p) => p.id === id)).length);
      checked++;
    }
  }
  ok(`every old cursor continues without skipping any product, reducer dedupes the repeats (${checked} cursors, ≤ ${maxRepeats} repeats)`, allComplete && checked > 10);
}

// ── 5. Unchanged areas ────────────────────────────────────────────────────────
console.log('\n5. Product Lock, homepage grid and client feed unchanged');
{
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  // Phase 2 base (the commit this work started from) — explicit, so the checks hold before AND after the commit.
  const BASE = 'beb89622957b436c5b8836f08ff17111a6544fdd';
  const LOCK_FILES = ['src/lib/productLock.js', 'src/components/Product/ProductLock.jsx', 'src/lib/services/productLockService.js',
    'src/app/api/admin/products/[id]/lock/route.js', 'src/lib/services/orderService.js', 'src/hooks/useCart.js'];
  ok('Product Lock rules, enforcement and admin control: files untouched', git(['diff', '--name-only', BASE, '--', ...LOCK_FILES]).trim() === '');
  const svcDiff = git(['diff', BASE, '--', 'src/lib/services/productService.js']).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  ok('productService: only the feed query (+ its comments / bound flag) changed', svcDiff.length > 0
    && svcDiff.every((l) => /^[+-]\s*(\/\/|\*|$)/.test(l) || /isLocked|createdAt", id\) <|ORDER BY|key \? key\.locked|One page of the Active product feed/.test(l))
    && !svcDiff.some((l) => /getAllProducts|orderBy:|publicListProduct\(|PRODUCT_COLUMNS|FEED_WHERE =|FEED_COUNT_SQL =/.test(l)), svcDiff.join('\n'));
  ok('homepage grid list unchanged (/api/products → getAllProducts, newest first)', /orderBy:\s*\{ createdAt: 'desc' \}/.test(SERVICE) && /fetchCached\("\/api\/products"\)/.test(read('src/components/Product/ProductGrid.jsx')));
  const client = read('src/app/products/ProductsClient.jsx') + read('src/hooks/useProductFeed.js');
  ok('no client-side sort (the order comes from the server)', !/\.sort\(/.test(client));
  ok('client feed, scroll restore and cache headers untouched', git(['diff', '--name-only', BASE, '--', 'src/app/products', 'src/hooks/useProductFeed.js', 'src/app/api/products']).trim() === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
