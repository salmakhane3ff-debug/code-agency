/**
 * scripts/lib/brandFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory stand-in for the Prisma client, covering only what the
 * "Create Your Own Brand" services use. Faithful on the points that matter —
 * it mirrors the database rules of migrations 20261028 + 20261029:
 *   • $transaction runs one at a time (models Serializable / row locks) and
 *     rolls back every write made inside it when it throws; deferred checks run
 *     at commit (authorization consumed by the request that references it)
 *   • brand_accesses: unique (affiliateId, clientRequestId), unique
 *     authorizationId, PARTIAL unique "one PENDING_PAYMENT/ACTIVE per affiliate"
 *     → P2002; snapshot columns frozen; only the approved status transitions
 *     (activation needs an ACCEPTED proof); CLOSED carries its closure, ACTIVE
 *     none; insert after a CLOSED access needs an unused authorization
 *   • brand_sim_hours: primary key (accessId, hourStart); createMany with
 *     skipDuplicates = ON CONFLICT DO NOTHING; rows are PERMANENT (no update /
 *     delete)
 *   • brand_audit_log and brand_sim_settings_versions are append-only
 *   • brand_access_periods: one open period per access; only "close once"
 *   • brand_payment_proofs: unique accessId / fingerprint; insert only for a
 *     request awaiting payment; one review SUBMITTED → ACCEPTED|REJECTED|WITHDRAWN
 *   • brand_request_authorizations: one unused per affiliate; revoke or consume
 *     once; consumption must point at a request that references it
 *   • 20261030 consent rules: brand_terms_versions / brand_access_consents are
 *     append-only; a new request's snapshot + fingerprint must match an immutable
 *     version (acceptedAt written at insert from the injectable `clock`); a proof
 *     insert and PENDING → ACTIVE need verified ORIGINAL consent; CLOSED → ACTIVE
 *     needs it or a REOPEN_RENEWAL to the latest version; a fresh consent needs an
 *     unverifiable request (PENDING / CLOSED) and the latest version. Guard errors
 *     carry the same SQLSTATE + message text the driver shows
 *   • `termsVersions` seed: defaults to the version published in the
 *     brand-refund-terms setting (as if it had been published through the app)
 *   • product and affiliateSecurityDeposit are READ ONLY (findMany only);
 *     affiliateNotification accepts only brand-keyed rows (eventKey "brand:…")
 *   • `strict: true` → any other model (orders, payouts, Rewards, UGC,
 *     boosters…) throws when touched; every call is logged in stats.log
 * It does NOT prove Postgres behaviour (the migrations are checked separately).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { classifyConsent, termsTextSha256 } from '../../src/lib/services/brandConsentService.js';

const clone = (v) => (v == null ? v : structuredClone(v));
const OPEN = ['PENDING_PAYMENT', 'ACTIVE'];
export const BRAND_MODELS = Object.freeze(['setting', 'affiliate', 'product', 'brandAccess', 'brandSimHour', 'brandAuditLog',
  'brandSimSettingsVersion', 'brandAccessPeriod', 'brandPaymentProof', 'brandRequestAuthorization', 'brandTermsVersion', 'brandAccessConsent']);
/** Shared tables the brand feature may touch: notifications (brand-keyed rows only) and deposits (read only). */
export const SHARED_MODELS = Object.freeze(['affiliateNotification', 'affiliateSecurityDeposit']);
/** Columns the DB trigger brand_accesses_guard freezes after insert. */
export const SNAPSHOT_COLUMNS = Object.freeze(['affiliateId', 'brandName', 'packageId', 'packageSnapshot', 'brandingOptionId', 'brandingSnapshot',
  'amount', 'termsVersion', 'termsSnapshot', 'termsTextSha256', 'selectedProducts', 'clientRequestId', 'authorizationId', 'createdAt']);
const TRANSITIONS = { PENDING_PAYMENT: ['ACTIVE', 'REJECTED', 'CANCELLED'], ACTIVE: ['CLOSED'], CLOSED: ['ACTIVE'] };

function p2002(target) {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002', meta: { target } });
}
const dbError = (msg) => Object.assign(new Error(msg), { code: 'P2010' });
/** A guard error as the driver shows it: SQLSTATE and message inside the text. */
const guardError = (sqlState, msg) => Object.assign(new Error(`ConnectorError(PostgresError { code: "${sqlState}", message: "${msg}" })`), { code: 'P2010' });
const isoMs = (d) => new Date(d).toISOString();

function matchValue(v, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(v);
    if ('notIn' in cond) return !cond.notIn.includes(v);
    if ('not' in cond) return !matchValue(v, cond.not);
    if ('contains' in cond) {
      const a = String(v ?? ''), b = String(cond.contains);
      return cond.mode === 'insensitive' ? a.toLowerCase().includes(b.toLowerCase()) : a.includes(b);
    }
    const t = v instanceof Date ? v.getTime() : v;
    const n = (x) => (x instanceof Date ? x.getTime() : x);
    if ('gte' in cond && !(t >= n(cond.gte))) return false;
    if ('lt' in cond && !(t < n(cond.lt))) return false;
    if ('lte' in cond && !(t <= n(cond.lte))) return false;
    if ('gt' in cond && !(t > n(cond.gt))) return false;
    return true;
  }
  if (cond === null) return v === null || v === undefined;
  const a = v instanceof Date ? v.getTime() : v;
  const b = cond instanceof Date ? cond.getTime() : cond;
  return a === b;
}

/** Version rows for the terms published in the brand-refund-terms setting (default seed). */
function publishedVersionRows(settings) {
  const p = settings?.['brand-refund-terms']?.published;
  if (!p || !Number.isInteger(p.version) || typeof p.text !== 'string' || !p.text.trim()) return [];
  return [{ version: p.version, text: p.text, publishedAt: p.publishedAt || '2026-01-01T00:00:00.000Z' }];
}

export function makeBrandFakeDb({ affiliates = [], settings = {}, products = [], deposits = [], strict = true, termsVersions, clock = () => new Date() } = {}) {
  const T = {
    setting: Object.entries(settings).map(([id, data]) => ({ id, data: clone(data), updatedAt: new Date(0) })),
    affiliate: affiliates.map((a) => ({ isActive: true, name: '', ...a })),
    product: products.map((p, i) => ({ status: 'Active', isActive: true, isLocked: false, images: [], createdAt: new Date(i * 1000), ...clone(p) })),
    affiliateSecurityDeposit: deposits.map((d) => ({ status: 'PENDING', ...clone(d) })),
    brandAccess: [], brandSimHour: [], brandAuditLog: [],
    brandSimSettingsVersion: [], brandAccessPeriod: [], brandPaymentProof: [], brandRequestAuthorization: [], affiliateNotification: [],
    brandTermsVersion: (termsVersions ?? publishedVersionRows(settings)).map((v) => ({
      publishedBy: null, publishAuditId: null, source: 'PUBLISH', createdAt: new Date(0), ...clone(v),
      publishedAt: new Date(v.publishedAt || 0), textSha256: v.textSha256 || termsTextSha256(v.text),
    })),
    brandAccessConsent: [],
  };
  const TX_TABLES = ['setting', 'brandAccess', 'brandSimHour', 'brandAuditLog', 'brandSimSettingsVersion', 'brandAccessPeriod',
    'brandPaymentProof', 'brandRequestAuthorization', 'affiliateNotification', 'brandTermsVersion', 'brandAccessConsent'];
  const stats = { log: [], txCount: 0 };
  let seq = 0;
  let chain = Promise.resolve();
  let pendingDeferred = [];
  const nextId = (p) => `${p}-${++seq}`;
  const tick = () => new Date(Date.now() + seq);

  const where = (table, w = {}) => (row) => Object.entries(w).every(([k, cond]) => {
    if (k === 'OR') return cond.some((c) => where(table, c)(row));
    if (k === 'AND') return cond.every((c) => where(table, c)(row));
    if (k === 'affiliate' && table === 'brandAccess') {
      const aff = T.affiliate.find((a) => a.id === row.affiliateId) || {};
      return Object.entries(cond).every(([ak, ac]) => matchValue(aff[ak], ac));
    }
    if (k === 'affiliateId_clientRequestId') return row.affiliateId === cond.affiliateId && row.clientRequestId === cond.clientRequestId;
    return matchValue(row[k], cond);
  });
  const sortRows = (rows, orderBy) => {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return rows.sort((x, y) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0];
        const a = x[k] instanceof Date ? x[k].getTime() : x[k];
        const b = y[k] instanceof Date ? y[k].getTime() : y[k];
        if (a !== b) return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  };
  const withInclude = (row, include) => {
    if (!row) return row;
    const out = clone(row);
    if (include?.affiliate) {
      const aff = T.affiliate.find((a) => a.id === row.affiliateId);
      out.affiliate = aff ? { username: aff.username, name: aff.name } : null;
    }
    if (include?.paymentProof) out.paymentProof = clone(T.brandPaymentProof.find((p) => p.accessId === row.id) || null);
    if (include?.periods) out.periods = sortRows(T.brandAccessPeriod.filter((p) => p.accessId === row.id), { startedAt: 'asc' }).map(clone);
    return out;
  };
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, clone(row[k])])) : clone(row));
  const findBy = (table, w) => T[table].find(where(table, w)) || null;

  // ── brand_accesses rules ──
  const checkAccessUniques = (row, selfId = null) => {
    if (T.brandAccess.some((r) => r.id !== selfId && r.affiliateId === row.affiliateId && r.clientRequestId === row.clientRequestId)) {
      throw p2002('brand_accesses_affiliateId_clientRequestId_key');
    }
    if (row.authorizationId && T.brandAccess.some((r) => r.id !== selfId && r.authorizationId === row.authorizationId)) {
      throw p2002('brand_accesses_authorizationId_key');
    }
    if (OPEN.includes(row.status) && T.brandAccess.some((r) => r.id !== selfId && r.affiliateId === row.affiliateId && OPEN.includes(r.status))) {
      throw p2002('brand_accesses_one_open_per_affiliate');
    }
  };
  const checkAccessRow = (row) => {
    if (row.status === 'CLOSED' && !(row.closedAt && row.closedBy && String(row.closeReason || '').trim())) throw dbError('brand_accesses_closure_check');
    if (row.status === 'ACTIVE' && (row.closedAt || row.closedBy || row.closeReason)) throw dbError('brand_accesses_closure_check');
    if (row.status === 'ACTIVE' && !(row.activatedAt && row.simulationStartsAt && row.paymentReference)) throw dbError('brand_accesses_values_check');
  };
  const unusedAuth = (id, affiliateId) => T.brandRequestAuthorization.find((a) => a.id === id && a.affiliateId === affiliateId && !a.revokedAt && !a.consumedAt);
  // brand_original_consent_ok / latest version (migration 20261030)
  const versionOf = (n) => T.brandTermsVersion.find((v) => v.version === n) || null;
  const latestVersion = () => T.brandTermsVersion.reduce((m, v) => (m && m.version > v.version ? m : v), null);
  const originalOk = (row) => classifyConsent(row, versionOf(row.termsVersion)) === 'VERIFIED';
  const reopenRenewalOk = (row) => {
    const latest = latestVersion();
    return !!latest && T.brandAccessConsent.some((c) => c.accessId === row.id && c.context === 'REOPEN_RENEWAL'
      && c.termsVersion === latest.version && c.termsTextSha256 === latest.textSha256);
  };

  const models = {
    setting: {
      async findUnique({ where: w }) { const r = T.setting.find((x) => x.id === w.id); return r ? clone(r) : null; },
      async upsert({ where: w, create, update }) {
        let r = T.setting.find((x) => x.id === w.id);
        if (r) Object.assign(r, clone(update));
        else { r = { ...clone(create), updatedAt: new Date() }; T.setting.push(r); }
        return clone(r);
      },
      async update({ where: w, data }) {
        const r = T.setting.find((x) => x.id === w.id);
        if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(r, clone(data), { updatedAt: new Date() });
        return clone(r);
      },
    },
    affiliate: {
      async findUnique({ where: w, select }) { const r = T.affiliate.find((x) => x.id === w.id); return r ? pick(r, select) : null; },
    },
    product: {
      async findMany({ where: w, select, orderBy, take } = {}) {
        return sortRows(T.product.filter(where('product', w)), orderBy).slice(0, take ?? Infinity).map((r) => pick(r, select));
      },
    },
    affiliateSecurityDeposit: {
      async findMany({ where: w, select } = {}) { return T.affiliateSecurityDeposit.filter(where('affiliateSecurityDeposit', w)).map((r) => pick(r, select)); },
    },
    affiliateNotification: {
      async create({ data }) {
        if (!String(data.eventKey || '').startsWith('brand:')) throw new Error('[brandFakeDb] only brand-keyed notifications may be written');
        if (T.affiliateNotification.some((n) => n.eventKey === data.eventKey)) throw p2002('affiliate_notifications_eventKey_key');
        const r = { id: nextId('ntf'), read: false, createdAt: tick(), ...clone(data) };
        T.affiliateNotification.push(r);
        return clone(r);
      },
      async findMany({ where: w, orderBy } = {}) { return sortRows(T.affiliateNotification.filter(where('affiliateNotification', w)), orderBy).map(clone); },
    },
    brandAccess: {
      async findUnique({ where: w, include }) { return withInclude(findBy('brandAccess', w), include); },
      async findFirst({ where: w, orderBy, select, include }) {
        const r = sortRows(T.brandAccess.filter(where('brandAccess', w)), orderBy)[0];
        return r ? (select ? pick(r, select) : withInclude(r, include)) : null;
      },
      async findMany({ where: w, orderBy, take, include, select } = {}) {
        return sortRows(T.brandAccess.filter(where('brandAccess', w)), orderBy).slice(0, take ?? Infinity).map((r) => (select ? pick(r, select) : withInclude(r, include)));
      },
      async count({ where: w } = {}) { return T.brandAccess.filter(where('brandAccess', w)).length; },
      async create({ data }) {
        const now = new Date();
        const row = {
          id: nextId('acc'), brandingOptionId: null, brandingSnapshot: null, selectedProducts: [], paymentReference: null, activatedAt: null, activatedBy: null,
          simulationStartsAt: null, closedAt: null, closedBy: null, closeReason: null, authorizationId: null, generatedThrough: null, lastReopenedAt: null,
          createdAt: new Date(now.getTime() + seq), updatedAt: now,
          ...clone(data),
        };
        // brand_accesses_consent_guard: database-written acceptance time, exact match
        if (!row.termsSnapshot || typeof row.termsSnapshot !== 'object') {
          throw guardError('BRC01', 'brand_accesses: consent does not match an immutable published terms version');
        }
        row.termsSnapshot = { ...row.termsSnapshot, acceptedAt: isoMs(clock()) };
        if (!row.termsTextSha256 || !originalOk(row)) {
          throw guardError('BRC01', 'brand_accesses: consent does not match an immutable published terms version');
        }
        // brand_accesses_insert_guard
        const hasClosed = T.brandAccess.some((r) => r.affiliateId === row.affiliateId && r.status === 'CLOSED');
        if ((row.authorizationId || hasClosed) && !unusedAuth(row.authorizationId, row.affiliateId)) {
          throw dbError('brand_accesses: a new request after a closed access needs an unused admin authorization');
        }
        checkAccessUniques(row);
        T.brandAccess.push(row);
        if (row.authorizationId) pendingDeferred.push(() => {
          const a = T.brandRequestAuthorization.find((x) => x.id === row.authorizationId);
          if (!a || a.consumedByAccessId !== row.id) throw dbError(`brand_accesses: authorization ${row.authorizationId} was not consumed by this request`);
        });
        return clone(row);
      },
      async updateMany({ where: w, data }) {
        const frozen = Object.keys(data).filter((k) => SNAPSHOT_COLUMNS.includes(k));
        if (frozen.length) throw new Error(`brand_accesses request snapshot is immutable (UPDATE of ${frozen.join(', ')} rejected)`);
        const rows = T.brandAccess.filter(where('brandAccess', w));
        for (const r of rows) {
          const next = { ...r, ...data };
          if (next.status !== r.status) {
            if (!(TRANSITIONS[r.status] || []).includes(next.status)) throw dbError(`brand_accesses: transition ${r.status} → ${next.status} is not allowed`);
            if (r.status === 'PENDING_PAYMENT' && next.status === 'ACTIVE' && !T.brandPaymentProof.some((p) => p.accessId === r.id && p.status === 'ACCEPTED')) {
              throw dbError('brand_accesses: activation requires an accepted payment proof');
            }
            if (r.status === 'PENDING_PAYMENT' && next.status === 'ACTIVE' && !originalOk(next)) {
              throw guardError('BRC02', 'brand_accesses: activation requires verified original consent');
            }
            if (r.status === 'CLOSED' && next.status === 'ACTIVE' && !originalOk(next) && !reopenRenewalOk(next)) {
              throw guardError('BRC03', 'brand_accesses: reopening requires verified original consent or a renewal to the latest terms');
            }
          }
          checkAccessRow(next);
          checkAccessUniques(next, r.id);
        }
        for (const r of rows) Object.assign(r, clone(data), { updatedAt: new Date() });
        return { count: rows.length };
      },
    },
    brandSimHour: {
      async findMany({ where: w, select, orderBy } = {}) {
        return sortRows(T.brandSimHour.filter(where('brandSimHour', w)), orderBy).map((r) => pick(r, select));
      },
      async count({ where: w } = {}) { return T.brandSimHour.filter(where('brandSimHour', w)).length; },
      async createMany({ data, skipDuplicates }) {
        let count = 0;
        for (const d of data) {
          const key = (r) => r.accessId === d.accessId && new Date(r.hourStart).getTime() === new Date(d.hourStart).getTime();
          if (T.brandSimHour.some(key)) {
            if (skipDuplicates) continue;
            throw p2002('brand_sim_hours_pkey');
          }
          T.brandSimHour.push({ ...clone(d), createdAt: new Date() });
          count++;
        }
        return { count };
      },
      async updateMany() { throw dbError('brand_sim_hours is permanent history (UPDATE rejected)'); },
      async deleteMany() { throw dbError('brand_sim_hours is permanent history (DELETE rejected)'); },
    },
    brandAuditLog: {
      async create({ data }) { const r = { id: nextId('aud'), createdAt: new Date(Date.now() + seq), ...clone(data) }; T.brandAuditLog.push(r); return clone(r); },
      async findMany({ where: w, orderBy, take } = {}) { return sortRows(T.brandAuditLog.filter(where('brandAuditLog', w)), orderBy).slice(0, take ?? Infinity).map(clone); },
      async update() { throw new Error('brand_audit_log is append-only (UPDATE rejected)'); },
      async delete() { throw new Error('brand_audit_log is append-only (DELETE rejected)'); },
    },
    brandSimSettingsVersion: {
      async count() { return T.brandSimSettingsVersion.length; },
      async findMany({ orderBy } = {}) { return sortRows([...T.brandSimSettingsVersion], orderBy).map(clone); },
      async create({ data }) {
        if (data.auditId && T.brandSimSettingsVersion.some((v) => v.auditId === data.auditId)) throw p2002('brand_sim_settings_versions_auditId_key');
        const r = { id: nextId('ver'), createdAt: tick(), auditId: null, ...clone(data) };
        T.brandSimSettingsVersion.push(r);
        return clone(r);
      },
      async updateMany() { throw dbError('brand_sim_settings_versions is append-only (UPDATE rejected)'); },
      async deleteMany() { throw dbError('brand_sim_settings_versions is append-only (DELETE rejected)'); },
    },
    brandAccessPeriod: {
      async create({ data }) {
        if (!data.endedAt && T.brandAccessPeriod.some((p) => p.accessId === data.accessId && !p.endedAt)) throw p2002('brand_access_periods_one_open');
        const r = { id: nextId('per'), endedAt: null, startAuditId: null, endAuditId: null, createdAt: tick(), ...clone(data) };
        T.brandAccessPeriod.push(r);
        return clone(r);
      },
      async findMany({ where: w, orderBy } = {}) { return sortRows(T.brandAccessPeriod.filter(where('brandAccessPeriod', w)), orderBy).map(clone); },
      async updateMany({ where: w, data }) {
        const rows = T.brandAccessPeriod.filter(where('brandAccessPeriod', w));
        for (const r of rows) {
          if (r.endedAt || !data.endedAt || Object.keys(data).some((k) => !['endedAt', 'endAuditId'].includes(k))) {
            throw dbError('brand_access_periods: only an open period can be closed, once');
          }
        }
        for (const r of rows) Object.assign(r, clone(data));
        return { count: rows.length };
      },
      async deleteMany() { throw dbError('brand_access_periods rows cannot be deleted'); },
    },
    brandPaymentProof: {
      async create({ data }) {
        const acc = T.brandAccess.find((a) => a.id === data.accessId);
        if (!acc || acc.status !== 'PENDING_PAYMENT') throw guardError('BRP01', 'brand_payment_proofs: a proof is submitted only for a request awaiting payment');
        if (!originalOk(acc)) throw guardError('BRC02', 'brand_payment_proofs: payment requires verified original consent');
        if (T.brandPaymentProof.some((p) => p.accessId === data.accessId)) throw p2002('brand_payment_proofs_accessId_key');
        if (T.brandPaymentProof.some((p) => p.fingerprint === data.fingerprint)) throw p2002('brand_payment_proofs_fingerprint_key');
        const now = new Date();
        const r = { id: nextId('prf'), status: 'SUBMITTED', reviewedBy: null, reviewedAt: null, rejectionReason: null, transferReference: null,
          transferReferenceNormalized: null, createdAt: tick(), updatedAt: now, ...clone(data) };
        T.brandPaymentProof.push(r);
        return clone(r);
      },
      async findUnique({ where: w }) { return clone(findBy('brandPaymentProof', w)); },
      async findFirst({ where: w }) { return clone(findBy('brandPaymentProof', w)); },
      async findMany({ where: w, orderBy } = {}) { return sortRows(T.brandPaymentProof.filter(where('brandPaymentProof', w)), orderBy).map(clone); },
      async updateMany({ where: w, data }) {
        const rows = T.brandPaymentProof.filter(where('brandPaymentProof', w));
        const allowed = ['status', 'reviewedBy', 'reviewedAt', 'rejectionReason'];
        for (const r of rows) {
          if (r.status !== 'SUBMITTED' || !['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(data.status) || Object.keys(data).some((k) => !allowed.includes(k))) {
            throw dbError('brand_payment_proofs: only one review of a submitted proof is allowed');
          }
          if (data.status === 'ACCEPTED' && T.brandAccess.find((a) => a.id === r.accessId)?.status !== 'PENDING_PAYMENT') {
            throw dbError('brand_payment_proofs: a proof is accepted only while its request awaits payment');
          }
        }
        for (const r of rows) Object.assign(r, clone(data), { updatedAt: new Date() });
        return { count: rows.length };
      },
      async deleteMany() { throw dbError('brand_payment_proofs rows cannot be deleted'); },
    },
    brandRequestAuthorization: {
      async create({ data }) {
        if (!String(data.reason || '').trim()) throw dbError('brand_request_authorizations_values_check');
        if (T.brandRequestAuthorization.some((a) => a.affiliateId === data.affiliateId && !a.revokedAt && !a.consumedAt)) throw p2002('brand_request_authorizations_one_unused');
        const r = { id: nextId('auth'), createdAt: tick(), revokedAt: null, revokedBy: null, revokeReason: null, revokeAuditId: null,
          consumedAt: null, consumedByAccessId: null, grantAuditId: null, ...clone(data) };
        T.brandRequestAuthorization.push(r);
        return clone(r);
      },
      async findUnique({ where: w }) { return clone(findBy('brandRequestAuthorization', w)); },
      async findFirst({ where: w, orderBy }) { return clone(sortRows(T.brandRequestAuthorization.filter(where('brandRequestAuthorization', w)), orderBy)[0] || null); },
      async findMany({ where: w, orderBy } = {}) { return sortRows(T.brandRequestAuthorization.filter(where('brandRequestAuthorization', w)), orderBy).map(clone); },
      async updateMany({ where: w, data }) {
        const rows = T.brandRequestAuthorization.filter(where('brandRequestAuthorization', w));
        for (const r of rows) {
          const keys = Object.keys(data);
          const revoke = keys.every((k) => ['revokedAt', 'revokedBy', 'revokeReason', 'revokeAuditId'].includes(k)) && data.revokedAt && String(data.revokeReason || '').trim() && data.revokedBy;
          const consume = keys.every((k) => ['consumedAt', 'consumedByAccessId'].includes(k)) && data.consumedAt && data.consumedByAccessId;
          if (r.revokedAt || r.consumedAt || !(revoke || consume)) throw dbError('brand_request_authorizations: only an unused authorization can be revoked or consumed, once');
          if (consume) {
            const acc = T.brandAccess.find((a) => a.id === data.consumedByAccessId);
            if (!acc || acc.affiliateId !== r.affiliateId || acc.authorizationId !== r.id) throw dbError('brand_request_authorizations: consumed by a request that does not reference it');
          }
          if (consume && T.brandRequestAuthorization.some((a) => a.id !== r.id && a.consumedByAccessId === data.consumedByAccessId)) throw p2002('brand_request_authorizations_consumedByAccessId_key');
        }
        for (const r of rows) Object.assign(r, clone(data));
        return { count: rows.length };
      },
      async deleteMany() { throw dbError('brand_request_authorizations rows cannot be deleted'); },
    },
    brandTermsVersion: {
      async findFirst({ where: w, orderBy } = {}) { return clone(sortRows(T.brandTermsVersion.filter(where('brandTermsVersion', w)), orderBy)[0] || null); },
      async findUnique({ where: w }) { return clone(findBy('brandTermsVersion', w)); },
      async findMany({ where: w, orderBy } = {}) { return sortRows(T.brandTermsVersion.filter(where('brandTermsVersion', w)), orderBy).map(clone); },
      async create({ data }) {
        if (T.brandTermsVersion.some((v) => v.version === data.version)) throw p2002('brand_terms_versions_pkey');
        if (!String(data.text || '').trim() || data.textSha256 !== termsTextSha256(data.text)) throw dbError('brand_terms_versions_values_check');
        const r = { publishedBy: null, publishAuditId: null, createdAt: tick(), ...clone(data) };
        T.brandTermsVersion.push(r);
        return clone(r);
      },
      async updateMany() { throw dbError('brand_terms_versions is append-only (UPDATE rejected)'); },
      async deleteMany() { throw dbError('brand_terms_versions is append-only (DELETE rejected)'); },
    },
    brandAccessConsent: {
      async findFirst({ where: w, orderBy } = {}) { return clone(sortRows(T.brandAccessConsent.filter(where('brandAccessConsent', w)), orderBy)[0] || null); },
      async findMany({ where: w, orderBy } = {}) { return sortRows(T.brandAccessConsent.filter(where('brandAccessConsent', w)), orderBy).map(clone); },
      async create({ data }) {
        const acc = T.brandAccess.find((a) => a.id === data.accessId);
        const latest = latestVersion();
        const contextOk = acc && ((acc.status === 'PENDING_PAYMENT' && data.context === 'PENDING_RENEWAL') || (acc.status === 'CLOSED' && data.context === 'REOPEN_RENEWAL'));
        if (!acc || acc.affiliateId !== data.affiliateId || !contextOk || originalOk(acc)
            || !latest || latest.version !== data.termsVersion || latest.textSha256 !== data.termsTextSha256) {
          throw guardError('BRC04', 'brand_access_consents: a fresh consent is not allowed for this request or terms version');
        }
        if (data.auditId && T.brandAccessConsent.some((c) => c.auditId === data.auditId)) throw p2002('brand_access_consents_auditId_key');
        const r = { id: nextId('cns'), createdAt: tick(), ...clone(data), acceptedAt: new Date(isoMs(clock())) };
        T.brandAccessConsent.push(r);
        return clone(r);
      },
      async updateMany() { throw dbError('brand_access_consents is append-only (UPDATE rejected)'); },
      async deleteMany() { throw dbError('brand_access_consents is append-only (DELETE rejected)'); },
    },
  };

  const logged = {};
  for (const [name, m] of Object.entries(models)) {
    logged[name] = Object.fromEntries(Object.entries(m).map(([fn, impl]) => [fn, (...args) => { stats.log.push(`${name}.${fn}`); return impl(...args); }]));
  }

  const base = {
    ...logged,
    _tables: T,
    _stats: stats,
    /** Advisory locks: transactions already run one at a time here — logged only. */
    async $executeRaw(strings, ...values) { stats.log.push(`$executeRaw:${String(strings.join('?')).trim()}:${values.join(',')}`); return 1; },
    async $transaction(fn) {
      const run = async () => {
        stats.txCount++;
        const snapshot = clone(Object.fromEntries(TX_TABLES.map((k) => [k, T[k]])));
        pendingDeferred = [];
        try {
          const result = await fn(db);
          for (const check of pendingDeferred) check(); // deferred constraint triggers at commit
          return result;
        } catch (e) {
          Object.assign(T, snapshot);
          throw e;
        } finally {
          pendingDeferred = [];
        }
      };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    },
  };

  const db = strict
    ? new Proxy(base, {
      get(target, prop) {
        if (prop in target || typeof prop === 'symbol' || prop === 'then') return target[prop];
        stats.log.push(`FORBIDDEN:${String(prop)}`);
        throw new Error(`[brandFakeDb] forbidden model access: ${String(prop)}`);
      },
    })
    : base;
  return db;
}
