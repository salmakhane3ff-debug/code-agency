/**
 * src/lib/services/payoutBankService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4 — bank logo picker + admin bank management (pure rules: src/lib/payoutBanks.js).
 *
 *   Admin    list (with how many users chose each bank) · create · edit (name, active,
 *            RIB required, order) · logo upload. NO delete: a bank is deactivated, and
 *            the DB refuses to delete a bank somebody chose (FK ON DELETE RESTRICT).
 *            A rename is copied into the bankName of every affiliate / recruiter who
 *            chose that bank (same transaction), so the payout screens stay right.
 *   Users    GET the ACTIVE catalogue (id, name, logo, ribRequired — nothing else).
 *   Affiliate  saveAffiliateBankSelection: the validated replacement of the old
 *            unvalidated "PUT /api/affiliate/me" bank write.
 *            (The recruiter's save lives in recruiterWalletService.saveRecruiterBank.)
 *
 * Logos: same checks as every other image upload (validateImage: extension allowlist,
 * magic bytes, script sniffing — SVG never accepted) plus this feature's own type list
 * and 2 MB cap; then RE-ENCODED (≤ 256 px WebP) — which also drops any trailing payload —
 * and stored through saveMedia (no watermark). Logos are public images; no private
 * document is ever stored or exposed here.
 * DB + storage + image processing are injectable for tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import prisma from '../prisma.js';
import {
  PAYOUT_BANK_LIMITS, bankPublicView, checkBankSelection, checkLogoFile, isBankId, parseAdminBankInput,
} from '../payoutBanks.js';

export const PAYOUT_BANK_FOLDER = 'payout-banks';
const ADMIN_SELECT = { id: true, name: true, logoUrl: true, isActive: true, ribRequired: true, sortOrder: true, createdAt: true, updatedAt: true };
const PUBLIC_SELECT = { id: true, name: true, logoUrl: true, isActive: true, ribRequired: true };
const ORDER = [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }];

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const invalid = (fields) => fail('INVALID_INPUT', { fields });

const adminView = (b, usage = 0) => ({
  id: b.id, name: b.name, logoUrl: b.logoUrl ?? null, isActive: b.isActive === true, ribRequired: b.ribRequired !== false,
  sortOrder: b.sortOrder ?? 0, createdAt: b.createdAt ?? null, updatedAt: b.updatedAt ?? null, usage,
});

/** Case-insensitive name clash with another bank (the DB unique index on lower(name) is the final word). */
async function nameTaken(db, name, exceptId = null) {
  const hit = await db.payoutBank.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return !!hit;
}
const isUniqueViolation = (e) => e?.code === 'P2002' || /payout_banks_name_lower_key/.test(String(e?.message ?? ''));

// ── Users: the active catalogue ─────────────────────────────────────────────

/** Active banks, catalogue order → [{ id, name, logoUrl, isActive: true, ribRequired }]. */
export async function listActivePayoutBanks({ db = prisma } = {}) {
  const rows = await db.payoutBank.findMany({ where: { isActive: true }, orderBy: ORDER, select: PUBLIC_SELECT });
  return rows.map(bankPublicView);
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** Every bank (active or not) + how many affiliates / recruiters chose it. */
export async function listPayoutBanksAdmin({ db = prisma } = {}) {
  const [rows, aff, rec] = await Promise.all([
    db.payoutBank.findMany({ orderBy: ORDER, select: ADMIN_SELECT }),
    db.affiliate.groupBy({ by: ['bankId'], where: { bankId: { not: null } }, _count: { _all: true } }),
    db.recruiter.groupBy({ by: ['bankId'], where: { bankId: { not: null } }, _count: { _all: true } }),
  ]);
  const usage = new Map();
  for (const r of [...aff, ...rec]) usage.set(r.bankId, (usage.get(r.bankId) ?? 0) + (r._count?._all ?? 0));
  return rows.map((b) => adminView(b, usage.get(b.id) ?? 0));
}

export async function createPayoutBank(input, { db = prisma } = {}) {
  const { fields, data } = parseAdminBankInput(input);
  if (fields) throw invalid(fields);
  if (await nameTaken(db, data.name)) throw invalid({ name: 'NAME_TAKEN' });
  try {
    const row = await db.payoutBank.create({ data, select: ADMIN_SELECT });
    return adminView(row, 0);
  } catch (e) {
    if (isUniqueViolation(e)) throw invalid({ name: 'NAME_TAKEN' });
    throw e;
  }
}

/** Partial edit (name / isActive / ribRequired / sortOrder). Deactivating never touches users' saved details. */
export async function updatePayoutBank(id, input, { db = prisma } = {}) {
  if (!isBankId(id)) throw fail('NOT_FOUND');
  const { fields, data } = parseAdminBankInput(input, { partial: true });
  if (fields) throw invalid(fields);
  const current = await db.payoutBank.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!current) throw fail('NOT_FOUND');
  if (data.name !== undefined && data.name.toLowerCase() !== current.name.toLowerCase() && await nameTaken(db, data.name, id)) {
    throw invalid({ name: 'NAME_TAKEN' });
  }
  try {
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.payoutBank.update({ where: { id }, data, select: ADMIN_SELECT });
      // bankName is the users' copy of the chosen bank's name: keep it in step with a rename.
      if (data.name !== undefined && data.name !== current.name) {
        await tx.affiliate.updateMany({ where: { bankId: id }, data: { bankName: data.name } });
        await tx.recruiter.updateMany({ where: { bankId: id }, data: { bankName: data.name } });
      }
      return updated;
    });
    return adminView(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw invalid({ name: 'NAME_TAKEN' });
    if (e?.code === 'P2025') throw fail('NOT_FOUND');
    throw e;
  }
}

/** Default logo pipeline: ≤ 256 px, WebP (sharp loaded lazily — server only). */
async function defaultProcessLogo(buffer) {
  const { default: sharp } = await import('sharp');
  try {
    return await sharp(buffer).rotate().resize(256, 256, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw fail('LOGO_INVALID');
  }
}
async function defaultStore(buffer) {
  const { saveMedia } = await import('../cloudinary.js');
  return saveMedia(buffer, { filename: `${Date.now()}-${randomUUID()}.webp`, folder: PAYOUT_BANK_FOLDER, subdir: PAYOUT_BANK_FOLDER, resourceType: 'image' });
}
async function defaultValidate(buffer, filename) {
  const { validateImage } = await import('../uploadSecurity.js');
  return validateImage(buffer, filename);
}

/**
 * Replace a bank's logo. file = { buffer, name, type }.
 * → the updated admin view. Errors: NOT_FOUND, LOGO_TYPE / LOGO_EMPTY / LOGO_TOO_LARGE / LOGO_INVALID.
 */
export async function setPayoutBankLogo(id, file, deps = {}) {
  const { db = prisma, validate = defaultValidate, processLogo = defaultProcessLogo, store = defaultStore } = deps;
  if (!isBankId(id)) throw fail('NOT_FOUND');
  const buffer = file?.buffer;
  const pre = checkLogoFile({ type: file?.type, name: file?.name, size: buffer?.length });
  if (pre) throw fail(pre);
  const v = await validate(buffer, String(file.name));
  if (!v?.ok) throw fail('LOGO_INVALID');
  const exists = await db.payoutBank.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw fail('NOT_FOUND');
  const webp = await processLogo(buffer);
  const saved = await store(webp);
  if (!saved?.url) throw fail('LOGO_STORAGE');
  const row = await db.payoutBank.update({ where: { id }, data: { logoUrl: saved.url }, select: ADMIN_SELECT });
  return adminView(row);
}

// ── Affiliate: save the selection ───────────────────────────────────────────

const AFFILIATE_BANK_KEYS = ['bankId', 'rib', 'accountName'];

/**
 * Affiliate: save their OWN bank details { bankId, accountName, rib? }.
 * → the saved { bankId, bankName, rib, accountName, bank }. Throws INVALID_INPUT { fields }.
 * Other keys of the body (e.g. a stale "bankName" or "type") are ignored: bankName always
 * comes from the catalogue.
 */
export async function saveAffiliateBankSelection(affiliateId, input, { db = prisma } = {}) {
  if (typeof affiliateId !== 'string' || !affiliateId) throw fail('UNAUTHORIZED');
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sel = Object.fromEntries(AFFILIATE_BANK_KEYS.map((k) => [k, body[k]]));
  const [me, bank] = await Promise.all([
    db.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true, bankId: true } }),
    isBankId(sel.bankId) ? db.payoutBank.findUnique({ where: { id: sel.bankId }, select: PUBLIC_SELECT }) : null,
  ]);
  if (!me) throw fail('UNAUTHORIZED');
  const { fields, data } = checkBankSelection({ ...sel, bank, currentBankId: me.bankId ?? null });
  if (fields) throw invalid(fields);
  const row = await db.affiliate.update({
    where: { id: affiliateId }, data,
    select: { bankId: true, bankName: true, rib: true, accountName: true, bank: { select: PUBLIC_SELECT } },
  });
  return { bankId: row.bankId, bankName: row.bankName, rib: row.rib, accountName: row.accountName, bank: bankPublicView(row.bank) };
}

// ── Route handlers (deps injectable for tests) ──────────────────────────────

const NO_STORE = { 'Cache-Control': 'no-store' };
const STATUS = { INVALID_INPUT: 400, NOT_FOUND: 404, LOGO_TYPE: 415, LOGO_INVALID: 415, LOGO_EMPTY: 400, LOGO_TOO_LARGE: 413 };
const MESSAGES = {
  INVALID_INPUT: 'Données invalides.',
  NOT_FOUND: 'Banque introuvable.',
  LOGO_TYPE: 'Formats acceptés : PNG, JPG, WEBP.',
  LOGO_INVALID: 'Image invalide.',
  LOGO_EMPTY: 'Fichier vide.',
  LOGO_TOO_LARGE: `Image trop lourde (max ${PAYOUT_BANK_LIMITS.LOGO_MAX_BYTES / 1024 / 1024} Mo).`,
};

function errorResponse(e, tag) {
  const code = e?.code;
  if (STATUS[code]) {
    return Response.json({ error: MESSAGES[code], code, ...(e.fields ? { fields: e.fields } : {}) }, { status: STATUS[code], headers: NO_STORE });
  }
  console.error(`[payout-banks] ${tag} error:`, e?.message ?? e);
  return Response.json({ error: 'Erreur serveur', code: 'SERVER_ERROR' }, { status: 500, headers: NO_STORE });
}
async function readJson(req) {
  try { return await req.json(); } catch { throw invalid({ body: 'INVALID_BODY' }); }
}
const paramId = async (ctx) => String((await ctx?.params)?.id ?? '');

export function payoutBankHandlers(deps = {}) {
  const { db = prisma, validate, processLogo, store } = deps;
  return {
    /** GET /api/payout-banks — the active catalogue (any visitor; names + logos only). */
    publicList: async () => {
      try { return Response.json({ banks: await listActivePayoutBanks({ db }) }, { headers: NO_STORE }); } catch (e) { return errorResponse(e, 'public list'); }
    },
    /** GET /api/admin/payout-banks */
    adminList: async () => {
      try { return Response.json({ banks: await listPayoutBanksAdmin({ db }) }, { headers: NO_STORE }); } catch (e) { return errorResponse(e, 'admin list'); }
    },
    /** POST /api/admin/payout-banks { name, isActive?, ribRequired?, sortOrder? } */
    adminCreate: async (req) => {
      try { return Response.json({ bank: await createPayoutBank(await readJson(req), { db }) }, { status: 201, headers: NO_STORE }); } catch (e) { return errorResponse(e, 'create'); }
    },
    /** PATCH /api/admin/payout-banks/[id] { name?, isActive?, ribRequired?, sortOrder? } */
    adminUpdate: async (req, ctx) => {
      try { return Response.json({ bank: await updatePayoutBank(await paramId(ctx), await readJson(req), { db }) }, { headers: NO_STORE }); } catch (e) { return errorResponse(e, 'update'); }
    },
    /** POST /api/admin/payout-banks/[id]/logo  multipart: logo=<file> */
    adminLogo: async (req, ctx) => {
      try {
        const id = await paramId(ctx);
        let form;
        try { form = await req.formData(); } catch { throw invalid({ logo: 'LOGO_MISSING' }); }
        const f = form.get('logo');
        if (!f || typeof f.arrayBuffer !== 'function') throw invalid({ logo: 'LOGO_MISSING' });
        if (Number(f.size) > PAYOUT_BANK_LIMITS.LOGO_MAX_BYTES) throw fail('LOGO_TOO_LARGE');
        const buffer = Buffer.from(await f.arrayBuffer());
        const bank = await setPayoutBankLogo(id, { buffer, name: f.name, type: f.type }, { db, validate, processLogo, store });
        return Response.json({ bank }, { headers: NO_STORE });
      } catch (e) { return errorResponse(e, 'logo'); }
    },
  };
}
