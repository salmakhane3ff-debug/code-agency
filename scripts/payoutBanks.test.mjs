#!/usr/bin/env node
/**
 * scripts/payoutBanks.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4 — bank logo picker & admin bank management (backend). In-memory fakes only
 * (never a real database, network, storage or image library).
 * Proves:
 *   1. admin catalogue: create (name trimmed / collapsed, defaults), validation, case-insensitive
 *      duplicate → NAME_TAKEN, strict body, partial edit, rename copied into the bankName of
 *      exactly the affiliates / recruiters who chose that bank, EMPTY_UPDATE, NOT_FOUND,
 *      activate / deactivate, NO delete, admin list with usage counts, public list (active only,
 *      catalogue order, public fields only), admin routes behind withAdminAuth
 *   2. logo upload (multipart through handlers.adminLogo): success, type / size / empty / content /
 *      missing-field / unknown-bank refusals, plus the REAL validateImage on a fake PNG
 *   3. affiliate selection (saveAffiliateBankSelection): RIB-required / RIB-not-required banks,
 *      field codes, typed bankName ignored
 *   4. deactivation: new users refused, existing users keep (and can re-save) their choice, no
 *      user row touched
 *   5. recruiter selection through the real wallet route handler (scripts/lib/recruiterFakeDb.mjs)
 *   6. payout eligibility: validateBankInfo, affiliate requestPayout, recruiter withdrawal
 *   7. team API never exposes another member's bank details; the owner still reads theirs;
 *      /api/affiliate/me PUT → 400 INVALID_INPUT { fields }
 * Run: node scripts/payoutBanks.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'payout-banks-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const PB = await import('../src/lib/payoutBanks.js');
const PBS = await import('../src/lib/services/payoutBankService.js');
const ASYS = await import('../src/lib/services/affiliateSystemService.js');
const WS = await import('../src/lib/services/recruiterWalletService.js');
const { validateImage } = await import('../src/lib/uploadSecurity.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { default: prisma } = await import('../src/lib/prisma.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, fields: e.fields ?? null }; } };
const silence = async (fn) => {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { out: await fn(), lines }; } finally { console.error = orig; }
};
const jsonReq = (body, { raw, method = 'POST', cookie } = {}) => new Request('http://localhost/api/admin/payout-banks', {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: raw !== undefined ? raw : JSON.stringify(body),
});
const read$ = async (res) => { const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; } return { status: res.status, body, text, cache: res.headers.get('cache-control') }; };
const ctxOf = (id) => ({ params: Promise.resolve({ id }) });
const RIB = '011780000012345678901234';

// ── A small Prisma-like fake: payoutBank / affiliate / recruiter (exactly what the services call) ──
function makeDb({ banks = [], affiliates = [], recruiters = [] } = {}) {
  const now = new Date('2026-11-15T10:00:00.000Z');
  const T = {
    payoutBank: banks.map((b) => ({ id: randomUUID(), logoUrl: null, isActive: true, ribRequired: true, sortOrder: 0, createdAt: now, updatedAt: now, ...b })),
    affiliate: affiliates.map((a) => ({ id: randomUUID(), bankId: null, bankName: null, rib: null, accountName: null, ...a })),
    recruiter: recruiters.map((r) => ({ id: randomUUID(), bankId: null, bankName: null, rib: null, accountName: null, ...r })),
  };
  const calls = [];
  const clone = (v) => structuredClone(v);
  const cmp = (v, c) => {
    if (c === null || typeof c !== 'object' || c instanceof Date) return v === c || (v instanceof Date && c instanceof Date && +v === +c);
    for (const [op, arg] of Object.entries(c)) {
      if (op === 'equals') { if (c.mode === 'insensitive' ? String(v).toLowerCase() !== String(arg).toLowerCase() : v !== arg) return false; }
      else if (op === 'mode') { /* modifier */ }
      else if (op === 'not') { if (arg === null ? v == null : v === arg) return false; }
      else if (op === 'in') { if (!arg.includes(v)) return false; }
      else throw new Error(`fake where: unsupported ${op}`);
    }
    return true;
  };
  const match = (row, where = {}) => Object.entries(where).every(([k, c]) => cmp(row[k], c));
  const sort = (list, orderBy) => {
    const o = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => { for (const x of o) { const [k, d] = Object.entries(x)[0]; if (a[k] === b[k]) continue; const r = a[k] < b[k] ? -1 : 1; return d === 'desc' ? -r : r; } return 0; });
  };
  const bankOf = (row) => (row.bankId ? T.payoutBank.find((b) => b.id === row.bankId) ?? null : null);
  const project = (row, { select, include } = {}) => {
    if (!row) return null;
    if (select) {
      const out = {};
      for (const [k, v] of Object.entries(select)) {
        if (!v) continue;
        if (k === 'bank') { const b = bankOf(row); out.bank = b ? (v === true ? clone(b) : project(b, v)) : null; }
        else out[k] = clone(row[k]);
      }
      return out;
    }
    const out = clone(row);
    if (include?.bank) out.bank = bankOf(row) ? clone(bankOf(row)) : null;
    return out;
  };
  const uniqueName = (row) => {
    if (T.payoutBank.some((b) => b.id !== row.id && b.name.toLowerCase() === row.name.toLowerCase())) {
      throw Object.assign(new Error('Unique constraint failed on payout_banks_name_lower_key'), { code: 'P2002' });
    }
  };
  const model = (name) => ({
    async findUnique(args) { calls.push([name, 'findUnique', args]); return project(T[name].find((r) => r.id === args.where.id), args); },
    async findFirst(args) { calls.push([name, 'findFirst', args]); return project(sort(T[name].filter((r) => match(r, args.where)), args.orderBy)[0], args); },
    async findMany(args = {}) { calls.push([name, 'findMany', args]); return sort(T[name].filter((r) => match(r, args.where)), args.orderBy).map((r) => project(r, args)); },
    async create(args) {
      calls.push([name, 'create', args]);
      const row = name === 'payoutBank'
        ? { id: randomUUID(), logoUrl: null, isActive: true, ribRequired: true, sortOrder: 0, createdAt: now, updatedAt: now, ...clone(args.data) }
        : { id: randomUUID(), ...clone(args.data) };
      if (name === 'payoutBank') uniqueName(row);
      T[name].push(row);
      return project(row, args);
    },
    async update(args) {
      calls.push([name, 'update', args]);
      const row = T[name].find((r) => r.id === args.where.id);
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      const next = { ...row, ...clone(args.data) };
      if (name === 'payoutBank') uniqueName(next);
      if (next.bankId != null && !T.payoutBank.some((b) => b.id === next.bankId)) throw Object.assign(new Error('FK bankId'), { code: 'P2003' });
      Object.assign(row, next);
      return project(row, args);
    },
    async updateMany(args) {
      calls.push([name, 'updateMany', args]);
      const hit = T[name].filter((r) => match(r, args.where));
      for (const r of hit) Object.assign(r, clone(args.data));
      return { count: hit.length };
    },
    async groupBy(args) {
      calls.push([name, 'groupBy', args]);
      const g = new Map();
      for (const r of T[name].filter((x) => match(x, args.where))) {
        const k = JSON.stringify(args.by.map((b) => r[b]));
        if (!g.has(k)) g.set(k, { ...Object.fromEntries(args.by.map((b) => [b, r[b]])), _count: { _all: 0 } });
        g.get(k)._count._all += 1;
      }
      return [...g.values()];
    },
  });
  const db = { payoutBank: model('payoutBank'), affiliate: model('affiliate'), recruiter: model('recruiter'), _T: T, _calls: calls };
  db.$transaction = async (fn) => {
    calls.push(['$transaction']);
    const snap = clone({ payoutBank: T.payoutBank, affiliate: T.affiliate, recruiter: T.recruiter });
    try { return await fn(db); } catch (e) { for (const k of Object.keys(snap)) T[k].splice(0, T[k].length, ...snap[k]); throw e; }
  };
  return db;
}
const pubKeys = ['id', 'isActive', 'logoUrl', 'name', 'ribRequired'];

// ── 1. admin catalogue ───────────────────────────────────────────────────────
console.log('\n1. Admin bank management: create / validate / edit / rename / (de)activate / list');
{
  const db = makeDb();
  const h = PBS.payoutBankHandlers({ db });
  const create = async (body, opts) => read$(await h.adminCreate(jsonReq(body, opts)));
  const update = async (id, body, opts) => read$(await h.adminUpdate(jsonReq(body, { method: 'PATCH', ...opts }), ctxOf(id)));

  const c1 = await create({ name: '  Attijari   wafa\tbank ' });
  const b1 = c1.body?.bank;
  ok('create → 201 no-store; name trimmed + whitespace collapsed; defaults ribRequired true / isActive true / sortOrder 0, logoUrl null, usage 0',
    c1.status === 201 && c1.cache === 'no-store' && b1?.name === 'Attijari wafa bank' && b1.ribRequired === true && b1.isActive === true && b1.sortOrder === 0
    && b1.logoUrl === null && b1.usage === 0 && PB.isBankId(b1.id) && eq(keys(b1), ['createdAt', 'id', 'isActive', 'logoUrl', 'name', 'ribRequired', 'sortOrder', 'updatedAt', 'usage']), c1.text);
  const c2 = await create({ name: 'Cash Plus', ribRequired: false, isActive: true, sortOrder: 2 });
  ok('create with explicit flags / order keeps them', c2.status === 201 && c2.body.bank.ribRequired === false && c2.body.bank.sortOrder === 2, c2.text);
  const c80 = await create({ name: 'N'.repeat(80), sortOrder: 9999, isActive: false });
  ok('boundaries accepted: an 80-character name, sortOrder 9999', c80.status === 201 && c80.body.bank.name.length === 80 && c80.body.bank.sortOrder === 9999, c80.text);

  const badNames = [{ name: '' }, { name: '    ' }, { name: 'N'.repeat(81) }, { name: '<x>' }, { name: 'Bank <b>' }, {}, { name: 42 }];
  const rn = [];
  for (const b of badNames) { const r = await create(b); rn.push(r.status === 400 && eq(r.body.fields, { name: 'INVALID_NAME' }) && r.body.code === 'INVALID_INPUT'); }
  ok('invalid names (empty, blank, > 80, angle brackets, missing, not a string) → 400 INVALID_INPUT fields.name INVALID_NAME', rn.every(Boolean), JSON.stringify(rn));
  const dup = await create({ name: 'ATTIJARI WAFA BANK' });
  const dup2 = await create({ name: ' attijari  wafa bank ' });
  ok('duplicate name, whatever the case / spacing → 400 fields.name NAME_TAKEN', dup.status === 400 && eq(dup.body.fields, { name: 'NAME_TAKEN' }) && dup2.status === 400 && eq(dup2.body.fields, { name: 'NAME_TAKEN' }), dup.text);
  const unk = await create({ name: 'X Bank', logoUrl: 'https://evil.example/x.png' });
  const unk2 = await create({ name: 'X Bank', id: randomUUID() });
  ok('unknown key (logoUrl / id) → 400 fields.body UNKNOWN_FIELD (logo only through the upload)', unk.status === 400 && eq(unk.body.fields, { body: 'UNKNOWN_FIELD' }) && eq(unk2.body.fields, { body: 'UNKNOWN_FIELD' }), unk.text);
  const flags = [
    [{ name: 'Y', isActive: 'true' }, { isActive: 'INVALID_FLAG' }],
    [{ name: 'Y', ribRequired: 1 }, { ribRequired: 'INVALID_FLAG' }],
    [{ name: 'Y', ribRequired: null }, { ribRequired: 'INVALID_FLAG' }],
    [{ name: 'Y', sortOrder: -1 }, { sortOrder: 'INVALID_SORT_ORDER' }],
    [{ name: 'Y', sortOrder: 1.5 }, { sortOrder: 'INVALID_SORT_ORDER' }],
    [{ name: 'Y', sortOrder: 10000 }, { sortOrder: 'INVALID_SORT_ORDER' }],
    [{ name: 'Y', sortOrder: '3' }, { sortOrder: 'INVALID_SORT_ORDER' }],
  ];
  const rf = [];
  for (const [b, f] of flags) { const r = await create(b); rf.push(r.status === 400 && eq(r.body.fields, f)); }
  ok('invalid flags (non-boolean isActive / ribRequired) and sortOrder (negative, fraction, > 9999, string) → 400 with the field code', rf.every(Boolean), JSON.stringify(rf));
  const badJson = await create(undefined, { raw: '{bad' });
  const arr = await create(undefined, { raw: '[]' });
  ok('malformed JSON / array body → 400 fields.body INVALID_BODY', badJson.status === 400 && eq(badJson.body.fields, { body: 'INVALID_BODY' }) && arr.status === 400 && eq(arr.body.fields, { body: 'INVALID_BODY' }));
  ok('no invalid request created a row (3 banks)', db._T.payoutBank.length === 3);

  // Race: the pre-check misses a concurrent insert → the unique index (P2002) still answers NAME_TAKEN.
  const raceDb = makeDb({ banks: [{ name: 'Race Bank' }] });
  raceDb.payoutBank.findFirst = async () => null;
  const race = await errOf(() => PBS.createPayoutBank({ name: 'race bank' }, { db: raceDb }));
  ok('a concurrent duplicate caught by the unique index (P2002) → NAME_TAKEN, not a 500', race?.code === 'INVALID_INPUT' && eq(race.fields, { name: 'NAME_TAKEN' }) && raceDb._T.payoutBank.length === 1, JSON.stringify(race));

  // Edit / rename propagation.
  const B1 = b1.id, B2 = c2.body.bank.id;
  db._T.affiliate.push(
    { id: 'a1', bankId: B1, bankName: 'Attijari wafa bank', rib: RIB, accountName: 'A One' },
    { id: 'a2', bankId: B2, bankName: 'Cash Plus', rib: null, accountName: 'A Two' },
    { id: 'a3', bankId: null, bankName: 'Attijari wafa bank', rib: RIB, accountName: 'Legacy typed' },
  );
  db._T.recruiter.push(
    { id: 'r1', bankId: B1, bankName: 'Attijari wafa bank', rib: RIB, accountName: 'R One' },
    { id: 'r2', bankId: null, bankName: 'Attijari wafa bank', rib: RIB, accountName: 'R Two' },
  );
  const e1 = await update(B1, { sortOrder: 5 });
  ok('partial edit (sortOrder only) → 200, other fields unchanged, no user row touched',
    e1.status === 200 && e1.body.bank.sortOrder === 5 && e1.body.bank.name === 'Attijari wafa bank' && e1.body.bank.ribRequired === true
    && db._T.affiliate.find((a) => a.id === 'a1').bankName === 'Attijari wafa bank' && !db._calls.some((c) => c[1] === 'updateMany'), e1.text);
  const e2 = await update(B1, { name: '  Attijariwafa   Bank ' });
  const A = (id) => db._T.affiliate.find((a) => a.id === id);
  const R = (id) => db._T.recruiter.find((r) => r.id === id);
  ok('rename → 200 (name cleaned) and bankName copied to EXACTLY the affiliates + recruiters with that bankId (other bank and legacy typed rows untouched)',
    e2.status === 200 && e2.body.bank.name === 'Attijariwafa Bank' && A('a1').bankName === 'Attijariwafa Bank' && R('r1').bankName === 'Attijariwafa Bank'
    && A('a2').bankName === 'Cash Plus' && A('a3').bankName === 'Attijari wafa bank' && R('r2').bankName === 'Attijari wafa bank'
    && A('a1').rib === RIB && A('a1').accountName === 'A One', e2.text);
  ok('the rename and the two copies run in ONE transaction (updateMany where { bankId } on affiliate and recruiter)',
    eq(db._calls.filter((c) => c[1] === 'updateMany').map((c) => [c[0], c[2].where, c[2].data]), [['affiliate', { bankId: B1 }, { bankName: 'Attijariwafa Bank' }], ['recruiter', { bankId: B1 }, { bankName: 'Attijariwafa Bank' }]])
    && /\$transaction\(async \(tx\) => \{[\s\S]*?tx\.payoutBank\.update[\s\S]*?tx\.affiliate\.updateMany[\s\S]*?tx\.recruiter\.updateMany/.test(read('src/lib/services/payoutBankService.js')));
  const caseOnly = await update(B1, { name: 'ATTIJARIWAFA BANK' });
  const clash = await update(B1, { name: 'cash plus' });
  ok('a case-only rename of the same bank is allowed; renaming onto another bank\'s name (any case) → NAME_TAKEN, nothing changed',
    caseOnly.status === 200 && A('a1').bankName === 'ATTIJARIWAFA BANK' && clash.status === 400 && eq(clash.body.fields, { name: 'NAME_TAKEN' })
    && db._T.payoutBank.find((b) => b.id === B1).name === 'ATTIJARIWAFA BANK', clash.text);
  const empty = await update(B1, {});
  const bad = await update(B1, { name: '' });
  const unkU = await update(B1, { logoUrl: '/x.png' });
  ok('edit: {} → EMPTY_UPDATE; invalid name → INVALID_NAME; unknown key → UNKNOWN_FIELD (all 400)',
    empty.status === 400 && eq(empty.body.fields, { body: 'EMPTY_UPDATE' }) && eq(bad.body.fields, { name: 'INVALID_NAME' }) && eq(unkU.body.fields, { body: 'UNKNOWN_FIELD' }));
  const nCalls = db._calls.length;
  const nf1 = await update(randomUUID(), { isActive: false });
  const nf2 = await update('not-an-id', { isActive: false });
  const nf3 = await update('', { isActive: false });
  ok('unknown bank id → 404 NOT_FOUND; malformed / empty id → 404 without any query', nf1.status === 404 && nf1.body.code === 'NOT_FOUND' && nf2.status === 404 && nf3.status === 404
    && db._calls.slice(nCalls).filter((c) => c[0] === 'payoutBank').length === 1, nf2.text);
  const off = await update(B2, { isActive: false });
  const on = await update(B2, { isActive: true });
  ok('deactivate → isActive false; activate → isActive true', off.status === 200 && off.body.bank.isActive === false && on.status === 200 && on.body.bank.isActive === true);
  ok('no delete: the handlers are exactly publicList / adminList / adminCreate / adminUpdate / adminLogo, the service exports no delete, no route exports DELETE',
    eq(Object.keys(h).sort(), ['adminCreate', 'adminList', 'adminLogo', 'adminUpdate', 'publicList'])
    && !Object.keys(PBS).some((k) => /delete|remove/i.test(k))
    && ['src/app/api/admin/payout-banks/route.js', 'src/app/api/admin/payout-banks/[id]/route.js', 'src/app/api/admin/payout-banks/[id]/logo/route.js', 'src/app/api/payout-banks/route.js']
      .every((f) => !/export\s+const\s+DELETE|export\s+(async\s+)?function\s+DELETE/.test(read(f)))
    && !/payoutBank\.delete/.test(read('src/lib/services/payoutBankService.js')));

  await update(B2, { sortOrder: 1 });
  const list = await read$(await h.adminList());
  const byId = Object.fromEntries((list.body.banks || []).map((b) => [b.id, b]));
  ok('admin list → every bank (inactive included), catalogue order (sortOrder, name), usage = affiliates + recruiters who chose it',
    list.status === 200 && list.cache === 'no-store' && list.body.banks.length === 3 && eq(list.body.banks.map((b) => b.sortOrder), [1, 5, 9999])
    && byId[B1].usage === 2 && byId[B2].usage === 1 && byId[c80.body.bank.id].usage === 0 && byId[c80.body.bank.id].isActive === false, list.text);
  const pub = await read$(await h.publicList());
  ok('public list → ONLY active banks, catalogue order, ONLY { id, name, logoUrl, isActive, ribRequired } (no usage / order / dates)',
    pub.status === 200 && pub.cache === 'no-store' && eq(pub.body.banks.map((b) => b.id), [B2, B1]) && pub.body.banks.every((b) => eq(keys(b), pubKeys) && b.isActive === true)
    && eq(pub.body.banks[0], { id: B2, name: 'Cash Plus', logoUrl: null, isActive: true, ribRequired: false }), pub.text);
  ok('public list query: where isActive true + the public select only', (() => { const c = db._calls.filter((x) => x[0] === 'payoutBank' && x[1] === 'findMany').pop()[2]; return eq(c.where, { isActive: true }) && eq(keys(c.select), pubKeys); })());

  const { lines } = await silence(async () => {
    const boom = makeDb(); boom.payoutBank.findMany = async () => { throw new Error('db down: secret detail'); };
    const r = await read$(await PBS.payoutBankHandlers({ db: boom }).publicList());
    ok('a database error → 500 { error, code: SERVER_ERROR } without the internal message', r.status === 500 && r.body.code === 'SERVER_ERROR' && !/secret detail/.test(r.text));
  });
  ok('…and the error is logged server-side', lines.some((l) => /secret detail/.test(l)));

  // Admin routes are behind withAdminAuth (the routes use the '@/…' alias: static check + the wrapper itself).
  const routes = ['src/app/api/admin/payout-banks/route.js', 'src/app/api/admin/payout-banks/[id]/route.js', 'src/app/api/admin/payout-banks/[id]/logo/route.js'].map(read);
  ok('admin routes: every export is withAdminAuth(h.admin…) (GET list, POST create, PATCH edit, POST logo); public route GET = h.publicList',
    /export const GET = withAdminAuth\(h\.adminList\);/.test(routes[0]) && /export const POST = withAdminAuth\(h\.adminCreate\);/.test(routes[0])
    && /export const PATCH = withAdminAuth\(h\.adminUpdate\);/.test(routes[1]) && /export const POST = withAdminAuth\(h\.adminLogo\);/.test(routes[2])
    && routes.every((s) => (s.match(/export const (GET|POST|PATCH|PUT|DELETE)\b/g) || []).length === (s.match(/withAdminAuth\(h\./g) || []).length)
    && /export const GET = h\.publicList;/.test(read('src/app/api/payout-banks/route.js')));
  const guarded = withAdminAuth(h.adminCreate);
  const anon = await guarded(jsonReq({ name: 'Anon Bank' }), {});
  const recr = await guarded(jsonReq({ name: 'Anon Bank' }, { cookie: `recruiter_token=${signToken({ recruiterId: 'r', username: 'r', type: 'recruiter' })}` }), {});
  const adm = await read$(await guarded(jsonReq({ name: 'Admin Bank' }, { cookie: `auth_token=${signToken({ userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' })}` }), {}));
  ok('withAdminAuth: anonymous / recruiter token refused (401 / 403), admin token → 201', [401, 403].includes(anon.status) && [401, 403].includes(recr.status) && adm.status === 201
    && !db._T.payoutBank.some((b) => b.name === 'Anon Bank'), `${anon.status} ${recr.status} ${adm.status}`);
}

// ── 2. logo upload ───────────────────────────────────────────────────────────
console.log('\n2. Logo upload: multipart, type / size / content checks, re-encoded + stored');
{
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const env = () => {
    const db = makeDb({ banks: [{ name: 'CIH Bank' }] });
    const s = { validated: [], processed: 0, stored: 0, validateOk: true };
    const deps = {
      db,
      validate: async (buf, name) => { s.validated.push([buf.length, name]); return s.validateOk ? { ok: true } : { ok: false, error: 'bad', status: 415 }; },
      processLogo: async (buf) => { s.processed++; return Buffer.from(`webp:${buf.length}`); },
      store: async (buf) => { s.stored++; return { url: `/uploads/payout-banks/logo-${s.stored}.webp`, bytes: buf.length }; },
    };
    return { db, s, h: PBS.payoutBankHandlers(deps), id: db._T.payoutBank[0].id };
  };
  const send = async (E, file, { id = E.id, field = 'logo' } = {}) => {
    const fd = new FormData();
    if (file !== undefined) fd.append(field, file);
    return read$(await E.h.adminLogo(new Request(`http://localhost/api/admin/payout-banks/${id}/logo`, { method: 'POST', body: fd }), ctxOf(id)));
  };
  const file = (bytes, name, type) => new File([bytes], name, { type });

  const E = env();
  const okRes = await send(E, file(PNG, 'cih.png', 'image/png'));
  ok('PNG upload → 200 { bank } with logoUrl from the store; validated once (bytes + name), re-encoded once, stored once',
    okRes.status === 200 && okRes.body.bank.logoUrl === '/uploads/payout-banks/logo-1.webp' && E.db._T.payoutBank[0].logoUrl === '/uploads/payout-banks/logo-1.webp'
    && eq(E.s.validated, [[PNG.length, 'cih.png']]) && E.s.processed === 1 && E.s.stored === 1, okRes.text);
  const jpg = await send(E, file(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]), 'x.JPEG', 'image/jpeg'));
  const webp = await send(E, file(Buffer.alloc(16, 2), 'x.webp', 'image/webp'));
  ok('JPEG (upper-case extension) and WEBP accepted', jpg.status === 200 && webp.status === 200 && E.db._T.payoutBank[0].logoUrl === '/uploads/payout-banks/logo-3.webp');

  const refusals = async (label, f, status, code, opts) => {
    const X = env();
    const r = await send(X, f, opts);
    ok(`${label} → ${status} ${code}; nothing processed / stored, logoUrl unchanged`,
      r.status === status && r.body.code === code && X.s.processed === 0 && X.s.stored === 0 && X.db._T.payoutBank[0].logoUrl === null, r.text);
    return { r, X };
  };
  await refusals('SVG (image/svg+xml, .svg)', file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg', 'image/svg+xml'), 415, 'LOGO_TYPE');
  await refusals('SVG bytes declared image/png with a .svg name', file(PNG, 'logo.svg', 'image/png'), 415, 'LOGO_TYPE');
  await refusals('a .png name declared image/svg+xml', file(PNG, 'logo.png', 'image/svg+xml'), 415, 'LOGO_TYPE');
  await refusals('GIF', file(Buffer.from('GIF89a'), 'logo.gif', 'image/gif'), 415, 'LOGO_TYPE');
  const big = await refusals('> 2 MB', file(Buffer.alloc(2 * 1024 * 1024 + 1, 1), 'big.png', 'image/png'), 413, 'LOGO_TOO_LARGE');
  ok('…the 2 MB cap is checked before the content validator', big.X.s.validated.length === 0);
  const exact = env();
  const ex = await send(exact, file(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length, 1)]), 'exact.png', 'image/png'));
  ok('exactly 2 MB accepted', ex.status === 200, ex.text);
  await refusals('empty file', file(Buffer.alloc(0), 'empty.png', 'image/png'), 400, 'LOGO_EMPTY');
  const V = env(); V.s.validateOk = false;
  const vr = await send(V, file(PNG, 'fake.png', 'image/png'));
  ok('validate() refusing the bytes → 415 LOGO_INVALID; not processed / stored', vr.status === 415 && vr.body.code === 'LOGO_INVALID' && V.s.processed === 0 && V.s.stored === 0 && V.db._T.payoutBank[0].logoUrl === null, vr.text);
  const miss = await refusals('missing "logo" field', undefined, 400, 'INVALID_INPUT');
  ok('…with fields.logo LOGO_MISSING', eq(miss.r.body.fields, { logo: 'LOGO_MISSING' }));
  await refusals('a text field instead of a file', 'not a file', 400, 'INVALID_INPUT');
  await refusals('the file under another field name', file(PNG, 'cih.png', 'image/png'), 400, 'INVALID_INPUT', { field: 'image' });
  const U = env();
  const ur = await send(U, file(PNG, 'cih.png', 'image/png'), { id: randomUUID() });
  const ub = await send(U, file(PNG, 'cih.png', 'image/png'), { id: '../etc' });
  ok('unknown bank → 404 NOT_FOUND; malformed id → 404; nothing processed / stored', ur.status === 404 && ur.body.code === 'NOT_FOUND' && ub.status === 404 && U.s.processed === 0 && U.s.stored === 0, ur.text);
  const nr = await read$(await env().h.adminLogo(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), ctxOf(randomUUID())));
  ok('a non-multipart body → 400 INVALID_INPUT (LOGO_MISSING)', nr.status === 400 && eq(nr.body.fields, { logo: 'LOGO_MISSING' }), nr.text);
  const S = env();
  const noUrl = await silence(async () => {
    const h2 = PBS.payoutBankHandlers({ db: S.db, validate: async () => ({ ok: true }), processLogo: async (b) => b, store: async () => ({}) });
    return read$(await h2.adminLogo(new Request('http://localhost/x', { method: 'POST', body: (() => { const f = new FormData(); f.append('logo', file(PNG, 'a.png', 'image/png')); return f; })() }), ctxOf(S.id)));
  });
  ok('storage returning no URL → 500, logoUrl unchanged', noUrl.out.status === 500 && S.db._T.payoutBank[0].logoUrl === null);

  // The REAL default validator (uploadSecurity.validateImage) through setPayoutBankLogo.
  const R = env();
  const stored = [];
  const real = { db: R.db, validate: validateImage, processLogo: async (b) => b, store: async () => { stored.push(1); return { url: '/uploads/payout-banks/real.webp' }; } };
  const fakePng = Buffer.from('this is not really a PNG image at all, just text bytes');
  const c1 = await codeOf(() => PBS.setPayoutBankLogo(R.id, { buffer: fakePng, name: 'logo.png', type: 'image/png' }, real));
  const polyglot = Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]);
  const c2 = await codeOf(() => PBS.setPayoutBankLogo(R.id, { buffer: polyglot, name: 'logo.png', type: 'image/png' }, real));
  ok('REAL validateImage: a fake PNG (wrong magic bytes) → LOGO_INVALID; a PNG carrying <script> → LOGO_INVALID; nothing stored',
    c1 === 'LOGO_INVALID' && c2 === 'LOGO_INVALID' && stored.length === 0 && R.db._T.payoutBank[0].logoUrl === null, `${c1} ${c2}`);
  const good = await PBS.setPayoutBankLogo(R.id, { buffer: PNG, name: 'logo.png', type: 'image/png' }, real);
  ok('REAL validateImage: genuine PNG magic bytes pass (positive control)', good.logoUrl === '/uploads/payout-banks/real.webp' && stored.length === 1);
  ok('default pipeline wiring: validateImage, sharp re-encode to ≤ 256 px WebP, saveMedia in folder payout-banks',
    /import\('\.\.\/uploadSecurity\.js'\)/.test(read('src/lib/services/payoutBankService.js')) && /resize\(256, 256/.test(read('src/lib/services/payoutBankService.js'))
    && /\.webp\(/.test(read('src/lib/services/payoutBankService.js')) && PBS.PAYOUT_BANK_FOLDER === 'payout-banks');
  ok('checkLogoFile units', PB.checkLogoFile({ type: 'image/png', name: 'a.png', size: 1 }) === null && PB.checkLogoFile({ type: 'image/png', name: 'a.png.svg', size: 1 }) === 'LOGO_TYPE'
    && PB.checkLogoFile({ type: 'image/png', name: 'a.png', size: NaN }) === 'LOGO_EMPTY' && PB.checkLogoFile({ type: 'image/webp', name: 'a', size: 1 }) === 'LOGO_TYPE'
    && PB.checkLogoFile({ type: 'image/jpeg', name: 'a.jpg', size: 2 * 1024 * 1024 + 1 }) === 'LOGO_TOO_LARGE');
}

// ── 3. affiliate selection ───────────────────────────────────────────────────
console.log('\n3. Affiliate bank selection (saveAffiliateBankSelection)');
const seedBanks = () => [
  { id: randomUUID(), name: 'CIH Bank', ribRequired: true, sortOrder: 1 },
  { id: randomUUID(), name: 'Cash Plus', ribRequired: false, sortOrder: 2 },
  { id: randomUUID(), name: 'Old Bank', ribRequired: true, isActive: false, sortOrder: 3 },
];
{
  const [CIH, CASH, OLD] = seedBanks();
  const db = makeDb({ banks: [CIH, CASH, OLD], affiliates: [{ id: 'aff1' }, { id: 'aff2' }] });
  const save = (input, id = 'aff1') => PBS.saveAffiliateBankSelection(id, input, { db });
  const row = (id = 'aff1') => db._T.affiliate.find((a) => a.id === id);

  const s1 = await save({ bankId: CIH.id, rib: '0117 8000 0012 3456 7890 1234', accountName: '  Ahmed   Benali ' });
  ok('RIB-required bank + valid RIB + holder → saved; bankName = catalogue name; RIB spaces removed; holder cleaned; returns the public bank',
    eq(s1, { bankId: CIH.id, bankName: 'CIH Bank', rib: RIB, accountName: 'Ahmed Benali', bank: { id: CIH.id, name: 'CIH Bank', logoUrl: null, isActive: true, ribRequired: true } })
    && row().bankId === CIH.id && row().bankName === 'CIH Bank' && row().rib === RIB && row().accountName === 'Ahmed Benali', JSON.stringify(s1));
  const s2 = await save({ bankId: CASH.id, accountName: 'Ahmed Benali', rib: RIB });
  ok('RIB-not-required bank → only the holder is required; the RIB is saved as null (cleared)', s2.rib === null && row().rib === null && row().bankId === CASH.id && row().bankName === 'Cash Plus');
  const s3 = await save({ bankId: CASH.id, accountName: 'Ahmed Benali' });
  ok('RIB-not-required bank without any RIB → saved', s3.bankId === CASH.id && s3.rib === null);
  const before = structuredClone(row());
  const cases = [
    [{ bankId: CIH.id, rib: RIB }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankId: CASH.id, accountName: '   ' }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankId: CIH.id, rib: RIB, accountName: '<b>x</b>' }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankId: CIH.id, rib: RIB, accountName: 'N'.repeat(81) }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankId: CIH.id, rib: '123456789', accountName: 'A B' }, { rib: 'INVALID_RIB' }],
    [{ bankId: CIH.id, accountName: 'A B' }, { rib: 'INVALID_RIB' }],
    [{ bankId: CIH.id, rib: '0117-8000-0012-3456', accountName: 'A B' }, { rib: 'INVALID_RIB' }],
    [{ bankId: CIH.id, rib: '1'.repeat(35), accountName: 'A B' }, { rib: 'INVALID_RIB' }],
    [{ rib: RIB, accountName: 'A B' }, { bankId: 'BANK_REQUIRED' }],
    [{ bankId: '', rib: RIB, accountName: 'A B' }, { bankId: 'BANK_REQUIRED' }],
    [{ bankId: randomUUID(), rib: RIB, accountName: 'A B' }, { bankId: 'BANK_UNAVAILABLE' }],
    [{ bankId: 'CIH Bank', rib: RIB, accountName: 'A B' }, { bankId: 'BANK_UNAVAILABLE' }],
    [{ bankId: 42, rib: RIB, accountName: 'A B' }, { bankId: 'BANK_UNAVAILABLE' }],
    [{ bankId: randomUUID(), rib: '12', accountName: '' }, { bankId: 'BANK_UNAVAILABLE', accountName: 'INVALID_ACCOUNT_NAME', rib: 'INVALID_RIB' }],
    [{}, { bankId: 'BANK_REQUIRED', accountName: 'INVALID_ACCOUNT_NAME' }],
  ];
  const res = [];
  for (const [b, f] of cases) { const e = await errOf(() => save(b)); res.push(e?.code === 'INVALID_INPUT' && eq(e.fields, f)); }
  ok('missing holder → INVALID_ACCOUNT_NAME; bad / missing RIB on a RIB-required bank → INVALID_RIB; no bankId → BANK_REQUIRED; unknown / non-id → BANK_UNAVAILABLE; every problem reported at once; row unchanged',
    res.every(Boolean) && eq(row(), before), JSON.stringify(res));
  const typed = await save({ bankName: 'Typed Evil Bank', bankId: CIH.id, rib: RIB, accountName: 'Ahmed Benali', type: 'bank', isActive: false, parentId: 'x' });
  ok('a typed "bankName" (and any other key) in the body is ignored: bankName = the catalogue name, nothing else written',
    typed.bankName === 'CIH Bank' && row().bankName === 'CIH Bank' && !('parentId' in row()) && !('isActive' in row())
    && eq(keys(db._calls.filter((c) => c[0] === 'affiliate' && c[1] === 'update').pop()[2].data), ['accountName', 'bankId', 'bankName', 'rib']));
  ok('not signed in / unknown affiliate → UNAUTHORIZED', (await codeOf(() => PBS.saveAffiliateBankSelection('', { bankId: CIH.id }, { db }))) === 'UNAUTHORIZED'
    && (await codeOf(() => PBS.saveAffiliateBankSelection('nobody', { bankId: CIH.id, rib: RIB, accountName: 'A' }, { db }))) === 'UNAUTHORIZED');
  ok('updateAffiliateBank goes through saveAffiliateBankSelection (no unvalidated write left)',
    /export async function updateAffiliateBank\(id, input\) \{\s*await saveAffiliateBankSelection\(id, input\);\s*return getAffiliateById\(id\);\s*\}/.test(read('src/lib/services/affiliateSystemService.js')));
}

// ── 4. deactivation ──────────────────────────────────────────────────────────
console.log('\n4. Deactivation: new users refused, existing users keep (and can re-save) their bank');
{
  const [CIH, CASH] = seedBanks();
  const db = makeDb({ banks: [CIH, CASH], affiliates: [{ id: 'old' }, { id: 'new' }], recruiters: [{ id: 'rold' }] });
  await PBS.saveAffiliateBankSelection('old', { bankId: CASH.id, accountName: 'Old User' }, { db });
  db._T.recruiter[0] = { ...db._T.recruiter[0], bankId: CASH.id, bankName: 'Cash Plus', accountName: 'Rec Old', rib: null };
  const snap = structuredClone({ a: db._T.affiliate, r: db._T.recruiter });
  const nCalls = db._calls.length;
  const off = await PBS.updatePayoutBank(CASH.id, { isActive: false }, { db });
  ok('deactivating (updatePayoutBank) changes no affiliate / recruiter row and runs no user write',
    off.isActive === false && eq(structuredClone({ a: db._T.affiliate, r: db._T.recruiter }), snap)
    && !db._calls.slice(nCalls).some((c) => ['affiliate', 'recruiter'].includes(c[0]) && /update/.test(c[1])));
  const e = await errOf(() => PBS.saveAffiliateBankSelection('new', { bankId: CASH.id, accountName: 'New User' }, { db }));
  ok('a NEW user cannot select the inactive bank → BANK_UNAVAILABLE', e?.code === 'INVALID_INPUT' && eq(e.fields, { bankId: 'BANK_UNAVAILABLE' }) && db._T.affiliate[1].bankId === null);
  const re = await PBS.saveAffiliateBankSelection('old', { bankId: CASH.id, accountName: 'Old User Renamed' }, { db });
  ok('the user whose saved bank is now inactive can re-save (holder change) and stays on it', re.bankId === CASH.id && re.accountName === 'Old User Renamed' && re.bank.isActive === false
    && db._T.affiliate[0].bankId === CASH.id);
  const sw = await PBS.saveAffiliateBankSelection('old', { bankId: CIH.id, accountName: 'Old User', rib: RIB }, { db });
  const back = await errOf(() => PBS.saveAffiliateBankSelection('old', { bankId: CASH.id, accountName: 'Old User' }, { db }));
  ok('…once they switch to another bank, they cannot come back to the inactive one', sw.bankId === CIH.id && back?.code === 'INVALID_INPUT' && eq(back.fields, { bankId: 'BANK_UNAVAILABLE' }));
  ok('the public list hides the inactive bank', eq((await PBS.listActivePayoutBanks({ db })).map((b) => b.id), [CIH.id]));
  const cur = PB.bankPublicView({ ...CASH, isActive: false });
  const act = PB.bankPublicView({ ...CIH, isActive: true });
  ok('selectableBanks: active banks + the user\'s own deactivated bank (appended once); others never see it',
    eq(PB.selectableBanks([act], cur).map((b) => b.id), [CIH.id, CASH.id]) && eq(PB.selectableBanks([act], null).map((b) => b.id), [CIH.id])
    && eq(PB.selectableBanks([act, cur], act).map((b) => b.id), [CIH.id]) && eq(PB.selectableBanks([act, cur], cur).map((b) => b.id), [CIH.id, CASH.id]));
  ok('a deactivated "RIB not required" bank still makes the existing holder eligible (withdrawal rule unchanged by deactivation)',
    ASYS.validateBankInfo({ bankName: 'Cash Plus', accountName: 'Old User', rib: null, ribRequired: false }).length === 0);
}

// ── 5. recruiter selection (real wallet route handler, recruiter fake db) ────
console.log('\n5. Recruiter bank selection through PUT /api/recruiter/wallet/bank');
const recruiterEnv = () => {
  const db = makeRecruiterFakeDb({ phase5: true });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  db._seed.settings({ version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 });
  for (const r of [A, B]) db._seed.recruiterIdentity({ recruiterId: r.id, status: 'APPROVED' });
  const CIH = db._seed.payoutBank({ name: 'CIH Bank', ribRequired: true, sortOrder: 1 });
  const CASH = db._seed.payoutBank({ name: 'Cash Plus', ribRequired: false, sortOrder: 2 });
  const h = recruiterWalletHandlers({ db, now: () => new Date('2026-11-15T10:00:00Z'), rateLimit: () => null });
  const cookie = (r) => `recruiter_token=${signToken({ recruiterId: r.id, username: r.username, type: 'recruiter' })}`;
  const put = async (r, body) => read$(await withRecruiterAuth(h.bank)(new Request('http://localhost/api/recruiter/wallet/bank', { method: 'PUT', headers: { cookie: cookie(r), 'content-type': 'application/json' }, body: JSON.stringify(body) }), {}));
  const wallet = async (r) => read$(await withRecruiterAuth(h.wallet)(new Request('http://localhost/api/recruiter/wallet', { headers: { cookie: cookie(r) } }), {}));
  const row = (r) => db._tables.recruiter.find((x) => x.id === r.id);
  return { db, A, B, CIH, CASH, put, wallet, row };
};
{
  const E = recruiterEnv();
  const pub = (b, isActive = b.isActive) => ({ id: b.id, name: b.name, logoUrl: null, isActive, ribRequired: b.ribRequired });
  const g = await E.put(E.A, { bankId: E.CIH.id, rib: '0117 8000 0012 3456 7890 1234', accountName: ' Recruteur   A ' });
  ok('RIB-required bank + RIB + holder → 200, bankName = catalogue name, RIB spaces removed, view has bankId + public bank',
    g.status === 200 && eq(g.body.bank, { bankName: 'CIH Bank', rib: RIB, accountName: 'Recruteur A', complete: true, bankId: E.CIH.id, bank: pub(E.CIH) })
    && E.row(E.A).bankId === E.CIH.id && E.row(E.A).bankName === 'CIH Bank', g.text);
  const c = await E.put(E.A, { bankId: E.CASH.id, rib: RIB, accountName: 'Recruteur A' });
  ok('RIB-not-required bank → 200, RIB cleared (null), complete', c.status === 200 && c.body.bank.rib === null && c.body.bank.complete === true && E.row(E.A).rib === null, c.text);
  const w = await E.wallet(E.A);
  ok('wallet GET shows the chosen bank (bankId + public bank, complete)', w.status === 200 && eq(w.body.wallet.bank, { bankName: 'Cash Plus', rib: null, accountName: 'Recruteur A', complete: true, bankId: E.CASH.id, bank: pub(E.CASH) }), w.text.slice(0, 300));
  const before = structuredClone(E.row(E.A));
  const cases = [
    [{ bankId: E.CIH.id, rib: RIB }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankId: E.CASH.id, accountName: '' }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankId: E.CIH.id, rib: '123', accountName: 'A B' }, { rib: 'INVALID_RIB' }],
    [{ bankId: E.CIH.id, accountName: 'A B' }, { rib: 'INVALID_RIB' }],
    [{ rib: RIB, accountName: 'A B' }, { bankId: 'BANK_REQUIRED' }],
    [{ bankId: randomUUID(), rib: RIB, accountName: 'A B' }, { bankId: 'BANK_UNAVAILABLE' }],
    [{ bankId: 'CIH Bank', rib: RIB, accountName: 'A B' }, { bankId: 'BANK_UNAVAILABLE' }],
    [{ bankName: 'CIH Bank', bankId: E.CIH.id, rib: RIB, accountName: 'A B' }, { body: 'UNKNOWN_FIELD' }],
    [{ bankName: 'CIH Bank', rib: RIB, accountName: 'A B' }, { body: 'UNKNOWN_FIELD' }],
  ];
  const res = [];
  for (const [b, f] of cases) { const r = await E.put(E.A, b); res.push(r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: f })); }
  ok('recruiter: INVALID_ACCOUNT_NAME / INVALID_RIB / BANK_REQUIRED / BANK_UNAVAILABLE exactly as the affiliate; a "bankName" key → UNKNOWN_FIELD; row unchanged',
    res.every(Boolean) && eq(E.row(E.A), before), JSON.stringify(res));
  const audits = E.db._tables.recruiterAuditLog.filter((a) => a.action === 'RECRUITER_BANK_UPDATED');
  ok('each successful save audited once (2), never with bank values', audits.length === 2 && audits.every((a) => a.details == null && a.recruiterId === E.A.id));

  // Deactivation (recruiter side).
  const snap = structuredClone(E.db._tables.recruiter);
  const off = await PBS.updatePayoutBank(E.CASH.id, { isActive: false }, { db: E.db });
  ok('deactivating the bank through updatePayoutBank (recruiter fake) changes no recruiter row', off.isActive === false && eq(structuredClone(E.db._tables.recruiter), snap));
  const nb = await E.put(E.B, { bankId: E.CASH.id, accountName: 'Recruteur B' });
  ok('a recruiter who never chose it → 400 BANK_UNAVAILABLE', nb.status === 400 && eq(nb.body.fields, { bankId: 'BANK_UNAVAILABLE' }) && E.row(E.B).bankId == null, nb.text);
  const keep = await E.put(E.A, { bankId: E.CASH.id, accountName: 'Recruteur A Bis' });
  ok('the recruiter already on it can re-save (holder change) and stays valid (complete)', keep.status === 200 && keep.body.bank.bankId === E.CASH.id && keep.body.bank.complete === true
    && keep.body.bank.bank.isActive === false && E.row(E.A).accountName === 'Recruteur A Bis', keep.text);
  // (Rename propagation is covered in section 1: the recruiter fake isolates affiliate writes, so the
  // rename's affiliate.updateMany cannot run there.)
}

// ── 6. payout eligibility ────────────────────────────────────────────────────
console.log('\n6. Payout eligibility: validateBankInfo, affiliate requestPayout, recruiter withdrawal');
{
  const V = ASYS.validateBankInfo;
  ok('ribRequired false → no RIB needed (missing / short / any), holder still needed, bankName still needed',
    V({ bankName: 'Cash Plus', accountName: 'A', rib: null, ribRequired: false }).length === 0 && V({ bankName: 'Cash Plus', accountName: 'A', rib: '12', ribRequired: false }).length === 0
    && eq(V({ bankName: 'Cash Plus', accountName: ' ', rib: null, ribRequired: false }), ['accountName']) && eq(V({ bankName: '', accountName: 'A', ribRequired: false }), ['bankName']));
  ok('ribRequired true / undefined / null / "false" (string) → the original rule (RIB 10 … 34 required)',
    [true, undefined, null, 'false', 0].every((rr) => eq(V({ bankName: 'B', accountName: 'A', rib: '', ribRequired: rr }), ['rib']) && eq(V({ bankName: 'B', accountName: 'A', rib: '123', ribRequired: rr }), ['ribLength'])
      && V({ bankName: 'B', accountName: 'A', rib: '1234567890', ribRequired: rr }).length === 0));
  ok('bankDetailsComplete (client hint) mirrors it', PB.bankDetailsComplete({ bankName: 'X', accountName: 'A', bank: { ribRequired: false } }) === true
    && PB.bankDetailsComplete({ bankName: 'X', accountName: 'A', bank: { ribRequired: true } }) === false && PB.bankDetailsComplete({ bankName: 'X', accountName: 'A', rib: '1234567890' }) === true
    && PB.bankDetailsComplete({ bankName: 'X', accountName: '', bank: { ribRequired: false } }) === false);

  // Affiliate requestPayout with a fake db (same approach as scripts/withdrawalBankGuard.test.mjs).
  const makeAff = (row, { idv = 'APPROVED' } = {}) => {
    const s = { txEntered: false, created: null, bankArgs: null, idvRead: false };
    const db = {
      _s: s,
      affiliate: { findUnique: async (args) => { if (!s.bankArgs) s.bankArgs = args; return row; } },
      identityVerification: { findUnique: async () => { s.idvRead = true; return idv ? { status: idv } : null; } },
      affiliateOrder: { findMany: async () => [], aggregate: async () => ({ _sum: {} }) },
      ugcEarning: { aggregate: async () => ({ _sum: { amount: null } }) },
      affiliatePayout: { create: async ({ data }) => { s.created = data; return { id: 'p1', ...data }; }, aggregate: async () => ({ _sum: { amount: null } }) },
    };
    db.$transaction = async (fn) => { s.txEntered = true; return fn(db); };
    return db;
  };
  const ribless = makeAff({ bankName: 'Cash Plus', accountName: 'Ahmed', rib: null, bank: { ribRequired: false } });
  const code1 = await codeOf(() => ASYS.requestPayout('aff1', 0.01, ribless));
  ok('affiliate: rib null + bank { ribRequired:false } passes the bank gate (reads the identity, reaches the balance tx)',
    code1 !== 'INCOMPLETE_BANK_INFO' && ribless._s.idvRead === true && (ribless._s.txEntered === true || code1 === 'INSUFFICIENT_BALANCE'), String(code1));
  ok('…requestPayout selects bank.ribRequired with the bank columns', eq(ribless._s.bankArgs?.select, { bankName: true, accountName: true, rib: true, bank: { select: { ribRequired: true } } }));
  const riblessNoId = makeAff({ bankName: 'Cash Plus', accountName: 'Ahmed', rib: null, bank: { ribRequired: false } }, { idv: 'PENDING' });
  ok('…then hits the identity gate as usual (PENDING → IDENTITY_NOT_VERIFIED, no tx)', (await codeOf(() => ASYS.requestPayout('aff1', 10, riblessNoId))) === 'IDENTITY_NOT_VERIFIED' && riblessNoId._s.txEntered === false);
  const blocked = [
    { bankName: 'CIH Bank', accountName: 'Ahmed', rib: null, bank: { ribRequired: true } },
    { bankName: 'CIH Bank', accountName: 'Ahmed', rib: '123', bank: { ribRequired: true } },
    { bankName: 'CIH Bank', accountName: 'Ahmed', rib: null, bank: null },
    { bankName: 'Typed Bank', accountName: 'Ahmed', rib: null },
    { bankName: 'Cash Plus', accountName: '', rib: null, bank: { ribRequired: false } },
    null,
  ];
  const br = [];
  for (const b of blocked) { const d = makeAff(b); br.push((await codeOf(() => ASYS.requestPayout('aff1', 10, d))) === 'INCOMPLETE_BANK_INFO' && d._s.txEntered === false && d._s.idvRead === false); }
  ok('affiliate: bank { ribRequired:true } without a valid RIB, no bank (legacy) without RIB, missing holder, no row → INCOMPLETE_BANK_INFO before identity / balance', br.every(Boolean), JSON.stringify(br));
  const legacy = makeAff({ bankName: 'Typed Bank', accountName: 'Ahmed', rib: RIB });
  const code2 = await codeOf(() => ASYS.requestPayout('aff1', 0.01, legacy));
  ok('affiliate: legacy typed details with a RIB (no catalogue bank) keep passing the gate', code2 !== 'INCOMPLETE_BANK_INFO' && legacy._s.idvRead === true, String(code2));

  // Recruiter withdrawal through the recruiter fake (KYC approved).
  const W = recruiterEnv();
  const a = W.db._seed.affiliate({ username: 'aff.w', name: 'Affilié W', isActive: false });
  W.db._seed.link({ affiliateId: a.id, recruiterId: W.A.id });
  W.db._seed.ledger({ recruiterId: W.A.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 20000, settingsVersion: 1, idempotencyKey: `recruit:${a.id}` });
  const wd = (amountMad = '10') => WS.requestRecruiterWithdrawal(W.A.id, { amountMad, requestId: randomUUID() }, { db: W.db });
  Object.assign(W.row(W.A), { bankId: W.CASH.id, bankName: 'Cash Plus', accountName: 'Recruteur A', rib: null });
  const r1 = await wd('10');
  ok('recruiter: a RIB-less "RIB not required" bank + holder → withdrawal created (pending, 1000 cents)', r1?.withdrawal?.status === 'pending' && r1.withdrawal.amountCents === 1000 && r1.replayed === false
    && W.db._tables.affiliatePayout.filter((p) => p.recruiterId === W.A.id).length === 1);
  Object.assign(W.row(W.A), { accountName: null });
  ok('recruiter: same bank without the holder → INCOMPLETE_BANK_INFO', (await codeOf(() => wd('10'))) === 'INCOMPLETE_BANK_INFO');
  Object.assign(W.row(W.A), { bankId: W.CIH.id, bankName: 'CIH Bank', accountName: 'Recruteur A', rib: null });
  const n0 = W.db._tables.affiliatePayout.length;
  ok('recruiter: a RIB-required bank and no RIB → INCOMPLETE_BANK_INFO, nothing written', (await codeOf(() => wd('10'))) === 'INCOMPLETE_BANK_INFO' && W.db._tables.affiliatePayout.length === n0);
  Object.assign(W.row(W.A), { bankId: W.CASH.id, bankName: 'Cash Plus' });
  W.db._tables.payoutBank.find((b) => b.id === W.CASH.id).ribRequired = true;
  ok('recruiter: the admin later turning "RIB required" on blocks the RIB-less recruiter until a RIB is added', (await codeOf(() => wd('10'))) === 'INCOMPLETE_BANK_INFO');
  Object.assign(W.row(W.A), { rib: RIB });
  const r2 = await wd('5');
  ok('…and a RIB unblocks it', r2?.withdrawal?.amountCents === 500);
  // (getRecruiterWallet directly: the wallet GET handler first reconciles rewards, which would reverse this
  // seeded reward — its affiliate has no delivered orders.)
  const wl = await WS.getRecruiterWallet(W.A.id, { db: W.db });
  ok('wallet bank "complete" follows the same rule (bankId + public bank, ribRequired now true, RIB present)', wl.bank.complete === true && wl.bank.bankId === W.CASH.id && wl.bank.bank.ribRequired === true);
  Object.assign(W.row(W.A), { rib: null });
  ok('…and is false for the same row without its RIB', (await WS.getRecruiterWallet(W.A.id, { db: W.db })).bank.complete === false);
  Object.assign(W.row(W.A), { bankId: null, bankName: 'CIH', rib: '0117800000123456', accountName: 'A' });
  ok('recruiter: legacy typed details (no bankId) keep the original rule and still withdraw', (await wd('1'))?.withdrawal?.amountCents === 100);
}

// ── 7. team API & the owner's own view ───────────────────────────────────────
console.log('\n7. The team API never exposes another member\'s bank details; the owner still reads theirs');
{
  const member = { id: 'm1', username: 'u', name: 'N', bankId: 'b', bank: { id: 'b' }, bankName: 'CIH', rib: RIB, accountName: 'Holder', deliveredOrdersCount: 3 };
  const stripped = ASYS.withoutBankDetails(member);
  ok('withoutBankDetails removes bankId / bank / bankName / rib / accountName, keeps the rest, never mutates its input',
    eq(stripped, { id: 'm1', username: 'u', name: 'N', deliveredOrdersCount: 3 }) && member.rib === RIB && member.bank.id === 'b');

  // getAffiliateTeam / getAffiliateById / updateAffiliateBank use the module-level prisma client: swap its
  // delegates for fakes (own, configurable properties in this Prisma version), restored in finally.
  const saved = Object.fromEntries(['affiliate', 'payoutBank'].map((k) => [k, Object.getOwnPropertyDescriptor(prisma, k)]));
  const swappable = ['affiliate', 'payoutBank'].every((k) => !saved[k] || saved[k].configurable);
  ok('the Prisma client delegates are own configurable properties (so the real functions can run against a fake)', swappable, JSON.stringify(saved.affiliate && { c: saved.affiliate.configurable, w: saved.affiliate.writable }));
  const [CIH] = seedBanks();
  const parent = `parent-${randomUUID()}`;
  const fake = makeDb({
    banks: [CIH],
    affiliates: [
      { id: parent, username: 'owner', name: 'Owner', parentId: null, bankId: CIH.id, bankName: 'CIH Bank', rib: RIB, accountName: 'Owner Holder', createdAt: new Date('2026-01-01') },
      { id: 'kid1', username: 'kid1', name: 'Kid 1', parentId: parent, bankId: CIH.id, bankName: 'CIH Bank', rib: '999988887777666655', accountName: 'Kid One Holder', referralStatus: 'active', createdAt: new Date('2026-01-02') },
      { id: 'kid2', username: 'kid2', name: 'Kid 2', parentId: parent, bankId: null, bankName: 'Typed', rib: '111122223333444455', accountName: 'Kid Two Holder', createdAt: new Date('2026-01-03') },
      { id: 'gk', username: 'gk', name: 'Grandkid', parentId: 'kid1', referralStatus: 'active', createdAt: new Date('2026-01-04') },
    ],
  });
  let team = null, own = null, upd = null, bad = null, realRun = false;
  try {
    Object.defineProperty(prisma, 'affiliate', { value: fake.affiliate, configurable: true, writable: true, enumerable: true });
    Object.defineProperty(prisma, 'payoutBank', { value: fake.payoutBank, configurable: true, writable: true, enumerable: true });
    realRun = prisma.affiliate === fake.affiliate;
    team = await ASYS.getAffiliateTeam(parent);
    own = await ASYS.getAffiliateById(parent);
    upd = await ASYS.updateAffiliateBank(parent, { bankId: CIH.id, rib: RIB, accountName: 'Owner New Holder', bankName: 'ignored' });
    bad = await errOf(() => ASYS.updateAffiliateBank(parent, { bankId: CIH.id, rib: RIB, accountName: '' }));
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(prisma, k, d); else delete prisma[k]; }
  }
  ok('the real getAffiliateTeam ran against the fake (prisma.affiliate swapped, then restored)', realRun && Array.isArray(team) && ['affiliate', 'payoutBank'].every((k) => (saved[k] ? Object.getOwnPropertyDescriptor(prisma, k)?.value === saved[k].value : !(k in prisma)))
    && prisma.affiliate !== fake.affiliate);
  const json = JSON.stringify(team);
  ok('getAffiliateTeam: 2 direct members, NO bankId / bank / bankName / rib / accountName key, no RIB or holder value anywhere in the payload',
    team?.length === 2 && team.every((m) => !['bankId', 'bank', 'bankName', 'rib', 'accountName'].some((k) => k in m))
    && !/999988887777666655|111122223333444455|Kid One Holder|Kid Two Holder|CIH Bank|Typed/.test(json), json?.slice(0, 300));
  ok('…and still the team data (ids, names, subReferrals counts)', eq(team?.map((m) => [m.id, m.name, m.subReferrals]), [['kid1', 'Kid 1', { active: 1, pending: 0 }], ['kid2', 'Kid 2', { active: 0, pending: 0 }]]));
  ok('the owner reads their OWN bank details (getAffiliateById → mapAffiliate: bankName / rib / accountName / bankId / public bank)',
    own?.bankName === 'CIH Bank' && own.rib === RIB && own.accountName === 'Owner Holder' && own.bankId === CIH.id
    && eq(own.bank, { id: CIH.id, name: 'CIH Bank', logoUrl: null, isActive: true, ribRequired: true }), JSON.stringify(own));
  ok('updateAffiliateBank (the /me PUT service) validates, ignores a typed bankName and returns the owner\'s full view',
    upd?.accountName === 'Owner New Holder' && upd.bankName === 'CIH Bank' && upd.rib === RIB && upd.bankId === CIH.id && bad?.code === 'INVALID_INPUT' && eq(bad.fields, { accountName: 'INVALID_ACCOUNT_NAME' }), JSON.stringify(bad));
  const svc = read('src/lib/services/affiliateSystemService.js');
  ok('static: getAffiliateTeam maps every member through withoutBankDetails(mapAffiliate(m)); getAffiliateById includes the bank relation',
    /\.\.\.withoutBankDetails\(mapAffiliate\(m\)\)/.test(svc) && /prisma\.affiliate\.findUnique\(\{ where: \{ id \}, include: \{ bank: true \} \}\)/.test(svc));
  const team$ = read('src/app/api/affiliate/team/route.js');
  const me$ = read('src/app/api/affiliate/me/route.js');
  ok('static: /api/affiliate/team returns getAffiliateTeam as-is; /api/affiliate/me returns team (spread of getAffiliateTeam members) next to the owner\'s own affiliate',
    /const team = await getAffiliateTeam\(decoded\.affiliateId\);\s*return Response\.json\(team\);/.test(team$)
    && /getAffiliateTeam\(decoded\.affiliateId\)/.test(me$) && /team\.map\(\(m\) => \(\{\s*\.\.\.m,/.test(me$) && /const affiliate = await getAffiliateById\(decoded\.affiliateId\);/.test(me$)
    && !/\b(rib|accountName|bankName)\b/.test(team$));
  ok('static: /api/affiliate/me PUT passes the body to updateAffiliateBank and maps INVALID_INPUT → 400 { error, code, fields }',
    /const affiliate = await updateAffiliateBank\(decoded\.affiliateId, body\);/.test(me$)
    && /if \(err\?\.code === 'INVALID_INPUT'\) \{\s*return Response\.json\(\{ error: '[^']+', code: err\.code, fields: err\.fields \}, \{ status: 400 \}\);/.test(me$)
    && !/const \{ bankName, rib, accountName \} = body/.test(me$));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
