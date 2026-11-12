/**
 * src/lib/services/paymentProofService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Payment Proofs — persistence and lifecycle of the admin-managed DISPLAY feed
 * (db and storage injected, so tests run on an in-memory fake).
 *
 * Completely independent: the ONLY tables used are payment_proofs and
 * payment_proof_events. No affiliate, user, payout, balance, commission, reward,
 * deposit or order is read or written here.
 *
 * Every admin change and its audit event are written in ONE transaction, and every
 * status transition is a conditional UPDATE … WHERE status IN (…), so a retry, a
 * double click or a race with the publisher worker can never apply it twice.
 * Publication goes through ONE pipeline (paymentProofPublisher.publishOnePaymentProof):
 * the dedicated worker publishes due proofs; an admin "Publier maintenant" publishes one
 * scheduled proof early through the same function (publishPaymentProofNow below).
 *
 * "Supprimer" (removePaymentProof) hides a proof from every affiliate at once, in any state,
 * WITHOUT deleting anything: an append-only REMOVE event is written (at most one per proof —
 * partial unique index), and an unpublished proof is also cancelled in the same transaction so
 * the worker can never publish it. Removal is separate from expiration (visibleUntil).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes } from 'crypto';
import prisma from '../prisma.js';
import { defaultPaymentProofStorage } from '../paymentProofStorage.js';
import { publishOnePaymentProof } from './paymentProofPublisher.js';
import { resolveAdminNames, nameOf } from './adminNameService.js';
import {
  PROOF_STATUS, PROOF_LIMITS, proofError as err, validateProofInput, isVisibleAt, isValidId,
  isValidPublicToken, publicProof, adminProof, casablancaLocal, encodeFeedCursor, decodeFeedCursor, visibleFeedWhere,
} from '../paymentProofs.js';

const ms = (d) => new Date(d).getTime();
const EDITABLE = [PROOF_STATUS.SCHEDULED, PROOF_STATUS.FAILED];
const isUnique = (e, field) => e?.code === 'P2002' && (!field || JSON.stringify(e?.meta?.target ?? '').includes(field));
const actorOrThrow = (actorId) => {
  if (typeof actorId !== 'string' || !actorId) throw err('UNAUTHORIZED', 'Administrateur non identifié.');
  return actorId;
};
const event = (tx, proofId, action, actor, at, details = null) =>
  tx.paymentProofEvent.create({ data: { proofId, action, actor, at, details } });

// "Publier maintenant": the retried request has a new server time, so only name + amount must match.
const sameRequest = (row, v) => row.displayName === v.displayName && row.displayAmountCents === v.amountCents
  && (v.publishMode === 'NOW' || ms(row.scheduledAt) === v.scheduledAt.getTime());

/**
 * Publish ONE scheduled proof now through the publication pipeline (`immediate`), with the
 * server clock read at that moment. → { status: 'PUBLISHED' | 'FAILED' | 'SKIPPED', row }.
 */
async function publishNowInternal(id, { db, storage, clock, actor }) {
  const r = await publishOnePaymentProof(id, { db, storage, now: clock(), immediate: true, actor });
  const row = await db.paymentProof.findUnique({ where: { id } });
  return { status: r === 'published' ? 'PUBLISHED' : r === 'failed' ? 'FAILED' : 'SKIPPED', row };
}
/** Admin shape of a proof just published by "Publier maintenant" (this request won the publication). */
const immediateProof = (out) => adminProof(out.row, { publishedImmediately: out.status === 'PUBLISHED' });
const publicationOf = (row) => (row.status === PROOF_STATUS.PUBLISHED
  ? { status: 'PUBLISHED', publishedAt: new Date(row.publishedAt).toISOString() }
  : row.status === PROOF_STATUS.FAILED ? { status: 'FAILED', reason: row.failureReason } : { status: row.status });

/**
 * Create ONE scheduled proof with its receipt. Idempotent per `clientRef`: a retry
 * with the same ref returns the existing proof ({ existing: true }) and stores
 * nothing; the same ref with different content → CLIENT_REF_CONFLICT.
 * Both declarations (privacy masked, authenticity) are mandatory and recorded
 * with the confirming admin and the confirmation time.
 * `publishMode: 'now'` ("Publier maintenant"): the proof is created, then published at once
 * through the publication pipeline; publishedAt = the server time of that publication
 * (`clock()`), and `publication` reports the outcome (PUBLISHED, or FAILED with its reason —
 * a failed proof is never shown as published). If the process stops in between, the proof
 * is already due and the worker publishes it at its next tick.
 */
export async function createPaymentProof(input, file, {
  db = prisma, storage = defaultPaymentProofStorage, now = new Date(), clock = () => new Date(), actorId = null,
} = {}) {
  const actor = actorOrThrow(actorId);
  const { value: v, errors } = validateProofInput(input, { nowMs: ms(now) });
  if (Object.keys(errors).length) throw err('INVALID_INPUT', 'Données invalides.', { errors });

  const nowMode = v.publishMode === 'NOW';
  const prior = await db.paymentProof.findUnique({ where: { clientRef: v.clientRef } });
  if (prior) {
    if (!sameRequest(prior, v)) throw err('CLIENT_REF_CONFLICT', 'Cette référence correspond à une autre preuve.');
    if (!nowMode) return { proof: adminProof(prior), existing: true };
    // Retry of a "Publier maintenant": publish it if the first request stopped before (idempotent).
    const out = prior.status === PROOF_STATUS.SCHEDULED ? await publishNowInternal(prior.id, { db, storage, clock, actor }) : { row: prior };
    return { proof: immediateProof(out), existing: true, publication: publicationOf(out.row) };
  }
  if (!file || !file.buffer) throw err('INVALID_FILE', 'Le reçu est requis.', { errors: { file: 'REQUIRED' } });
  const problems = storage.validate({ mime: file.mime, size: file.size ?? file.buffer.length });
  if (problems.length) throw err('INVALID_FILE', 'Reçu refusé (type ou taille).', { errors: { file: problems.join(',') } });

  const stored = await storage.store(file.buffer);
  try {
    const row = await db.$transaction(async (tx) => {
      const dup = await tx.paymentProof.findFirst({
        where: { fingerprint: stored.fingerprint, status: { not: PROOF_STATUS.CANCELLED } }, select: { id: true },
      });
      if (dup) throw err('DUPLICATE_RECEIPT', 'Ce reçu est déjà programmé ou publié.');
      const created = await tx.paymentProof.create({
        data: {
          displayName: v.displayName, displayAmountCents: v.amountCents,
          fileKey: stored.key, fingerprint: stored.fingerprint, publicToken: randomBytes(16).toString('hex'),
          status: PROOF_STATUS.SCHEDULED, scheduledAt: v.scheduledAt, batchId: v.batchId, clientRef: v.clientRef,
          privacyConfirmedAt: now, privacyConfirmedBy: actor, authenticityConfirmedAt: now, authenticityConfirmedBy: actor,
          createdBy: actor, updatedBy: actor,
        },
      });
      await event(tx, created.id, 'CREATE', actor, now, {
        displayName: v.displayName, amountCents: v.amountCents, scheduledAt: v.scheduledAt.toISOString(), batchId: v.batchId,
        ...(nowMode ? { publishMode: 'NOW' } : {}),
      });
      await event(tx, created.id, 'CONFIRM_PRIVACY', actor, now);
      await event(tx, created.id, 'CONFIRM_AUTHENTICITY', actor, now);
      return created;
    });
    if (!nowMode) return { proof: adminProof(row), existing: false };
    const out = await publishNowInternal(row.id, { db, storage, clock, actor });
    return { proof: immediateProof(out), existing: false, publication: publicationOf(out.row) };
  } catch (e) {
    await storage.remove(stored.key).catch(() => {}); // never leave an orphan receipt behind
    if (isUnique(e, 'clientRef')) {
      const raced = await db.paymentProof.findUnique({ where: { clientRef: v.clientRef } });
      if (raced && sameRequest(raced, v)) return { proof: adminProof(raced), existing: true };
      throw err('CLIENT_REF_CONFLICT', 'Cette référence correspond à une autre preuve.');
    }
    if (isUnique(e, 'fingerprint')) throw err('DUPLICATE_RECEIPT', 'Ce reçu est déjà programmé ou publié.');
    throw e;
  }
}

/**
 * Review step of a manual bulk schedule (no file, nothing written): validates every
 * item, flags duplicates inside the batch and clientRefs already used (ONE query),
 * and returns the schedule grouped by Casablanca day (count per day and times are
 * exactly what the admin entered — nothing is distributed automatically).
 */
export async function validatePaymentProofBatch(items, { db = prisma, now = new Date() } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw err('INVALID_INPUT', 'Le lot est vide.');
  if (items.length > PROOF_LIMITS.MAX_BATCH_ITEMS) throw err('INVALID_INPUT', `Maximum ${PROOF_LIMITS.MAX_BATCH_ITEMS} preuves par lot.`);
  const nowMs = ms(now);
  const checked = items.map((it) => validateProofInput(it, { nowMs }));
  const refs = [...new Set(checked.map((c) => c.value.clientRef).filter(Boolean))];
  const usedRefs = refs.length ? await db.paymentProof.findMany({ where: { clientRef: { in: refs } }, select: { clientRef: true } }) : [];
  const used = new Set(usedRefs.map((r) => r.clientRef));
  const seenRef = new Map(), seenSlot = new Map();
  const out = checked.map(({ value: v, errors }, i) => {
    const e = { ...errors };
    if (v.clientRef) {
      if (seenRef.has(v.clientRef)) e.clientRef = 'DUPLICATE_IN_BATCH';
      else seenRef.set(v.clientRef, i);
      if (used.has(v.clientRef)) e.clientRef = 'ALREADY_CREATED';
    }
    if (v.displayName && !Number.isNaN(v.amountCents) && v.scheduledAt) {
      const slot = `${v.displayName.toLowerCase()}|${v.amountCents}|${v.scheduledAt.getTime()}`;
      if (seenSlot.has(slot)) e.duplicateOf = seenSlot.get(slot);
      else seenSlot.set(slot, i);
    }
    return {
      index: i, ok: Object.keys(e).length === 0, errors: e, publishNow: v.publishMode === 'NOW',
      displayName: v.displayName, amount: Number.isNaN(v.amountCents) ? null : v.amountCents / 100,
      scheduledAt: v.scheduledAt ? v.scheduledAt.toISOString() : null,
      scheduledLocal: v.scheduledAt ? casablancaLocal(v.scheduledAt.getTime()) : null,
    };
  });
  const days = {};
  for (const r of out) if (r.scheduledLocal) (days[r.scheduledLocal.date] ||= []).push(r.index);
  return { ok: out.every((r) => r.ok), items: out, days };
}

/**
 * Edit a proof before publication: new time, display name and/or amount. Both
 * declarations must be confirmed again (recorded anew). FAILED → SCHEDULED again.
 */
export async function updatePaymentProofSchedule(id, input, { db = prisma, storage = defaultPaymentProofStorage, now = new Date(), actorId = null } = {}) {
  const actor = actorOrThrow(actorId);
  if (!isValidId(id)) throw err('NOT_FOUND', 'Preuve introuvable.');
  const row = await db.paymentProof.findUnique({ where: { id } });
  if (!row) throw err('NOT_FOUND', 'Preuve introuvable.');
  if (!EDITABLE.includes(row.status)) throw err('NOT_EDITABLE', 'Cette preuve ne peut plus être modifiée.', { status: row.status });
  const merged = {
    clientRef: row.clientRef,
    displayName: input?.displayName ?? row.displayName,
    amount: input?.amount ?? (row.displayAmountCents / 100).toFixed(2),
    date: input?.date, time: input?.time,
    privacyConfirmed: input?.privacyConfirmed, authenticityConfirmed: input?.authenticityConfirmed,
  };
  const { value: v, errors } = validateProofInput(merged, { nowMs: ms(now) });
  if (Object.keys(errors).length) throw err('INVALID_INPUT', 'Données invalides.', { errors });
  if (!(await storage.exists(row.fileKey))) throw err('RECEIPT_MISSING', 'Le fichier du reçu est introuvable : annulez cette preuve et créez-en une nouvelle.');
  const before = { displayName: row.displayName, amountCents: row.displayAmountCents, scheduledAt: new Date(row.scheduledAt).toISOString(), status: row.status };
  const updated = await db.$transaction(async (tx) => {
    const res = await tx.paymentProof.updateMany({
      where: { id, status: { in: EDITABLE } },
      data: {
        status: PROOF_STATUS.SCHEDULED, scheduledAt: v.scheduledAt, displayName: v.displayName, displayAmountCents: v.amountCents,
        failedAt: null, failureReason: null, updatedBy: actor,
        privacyConfirmedAt: now, privacyConfirmedBy: actor, authenticityConfirmedAt: now, authenticityConfirmedBy: actor,
      },
    });
    if (res.count !== 1) throw err('NOT_EDITABLE', 'Cette preuve vient d’être publiée ou annulée.');
    await event(tx, id, 'EDIT', actor, now, {
      before, after: { displayName: v.displayName, amountCents: v.amountCents, scheduledAt: v.scheduledAt.toISOString(), status: PROOF_STATUS.SCHEDULED },
    });
    await event(tx, id, 'CONFIRM_PRIVACY', actor, now);
    await event(tx, id, 'CONFIRM_AUTHENTICITY', actor, now);
    return tx.paymentProof.findUnique({ where: { id } });
  });
  return adminProof(updated);
}

/** Cancel before publication (idempotent: cancelling a cancelled proof is a no-op). The record is kept. */
/**
 * "Publier maintenant" for a SCHEDULED proof (before its planned time), through the publication
 * pipeline — same checks, same conditional UPDATE as the worker; publishedAt = the server time of
 * the publication (`clock()`), so its 72 h window starts then. Exactly once: a second request,
 * the worker or an edit / cancel racing it finds the proof no longer SCHEDULED and changes nothing.
 *   → { proof, publication: { status: 'PUBLISHED', publishedAt } } (alreadyPublished: true when another
 *     request published it first — nothing is published twice);
 * @throws NOT_FOUND | NOT_PUBLISHABLE (cancelled / failed) | PUBLISH_FAILED (now FAILED, with its reason)
 */
export async function publishPaymentProofNow(id, { db = prisma, storage = defaultPaymentProofStorage, clock = () => new Date(), actorId = null } = {}) {
  const actor = actorOrThrow(actorId);
  if (!isValidId(id)) throw err('NOT_FOUND', 'Preuve introuvable.');
  const out = await publishNowInternal(id, { db, storage, clock, actor });
  if (!out.row) throw err('NOT_FOUND', 'Preuve introuvable.');
  if (out.status === 'PUBLISHED') return { proof: immediateProof(out), publication: publicationOf(out.row) };
  if (out.status === 'FAILED') {
    throw err('PUBLISH_FAILED', 'La publication a échoué : la preuve est marquée en échec.', { reason: out.row.failureReason, proof: adminProof(out.row) });
  }
  if (out.row.status === PROOF_STATUS.PUBLISHED) return { proof: adminProof(out.row), publication: publicationOf(out.row), alreadyPublished: true };
  throw err('NOT_PUBLISHABLE', 'Seule une preuve programmée peut être publiée maintenant.', { status: out.row.status });
}

export async function cancelPaymentProof(id, { db = prisma, now = new Date(), actorId = null } = {}) {
  const actor = actorOrThrow(actorId);
  if (!isValidId(id)) throw err('NOT_FOUND', 'Preuve introuvable.');
  const out = await db.$transaction(async (tx) => {
    const res = await tx.paymentProof.updateMany({
      where: { id, status: { in: EDITABLE } },
      data: { status: PROOF_STATUS.CANCELLED, cancelledAt: now, updatedBy: actor },
    });
    if (res.count === 1) await event(tx, id, 'CANCEL', actor, now);
    return { changed: res.count === 1, row: await tx.paymentProof.findUnique({ where: { id } }) };
  });
  if (!out.row) throw err('NOT_FOUND', 'Preuve introuvable.');
  if (!out.changed && out.row.status !== PROOF_STATUS.CANCELLED) throw err('NOT_CANCELLABLE', 'Une preuve publiée ne peut pas être annulée.', { status: out.row.status });
  return { proof: adminProof(out.row), alreadyCancelled: !out.changed };
}

/**
 * "Supprimer" — remove a proof from the affiliate slider at once (any status), keeping the
 * record and its whole history. ONE transaction:
 *   1. an unpublished proof (SCHEDULED / FAILED) becomes CANCELLED (conditional UPDATE — a
 *      concurrent publication wins or loses atomically; either way the proof ends hidden);
 *   2. an append-only REMOVE event records who / when / the state it had.
 * Idempotent: a proof already removed → { alreadyRemoved: true }, nothing written (a
 * concurrent second request hits the partial unique index and gets the same answer).
 * Hidden from then on: the feed and the receipt image exclude removed proofs, the publication
 * pipeline skips them and the DB trigger payment_proofs_no_publish_removed refuses publishing one.
 *   → { proof, alreadyRemoved }
 */
export async function removePaymentProof(id, { db = prisma, now = new Date(), actorId = null } = {}) {
  const actor = actorOrThrow(actorId);
  if (!isValidId(id)) throw err('NOT_FOUND', 'Preuve introuvable.');
  const finish = async (alreadyRemoved) => {
    const [row, w] = await Promise.all([
      db.paymentProof.findUnique({ where: { id } }),
      db.paymentProofEvent.findFirst({ where: { proofId: id, action: 'REMOVE' } }),
    ]);
    if (!row) throw err('NOT_FOUND', 'Preuve introuvable.');
    const names = await resolveAdminNames(w ? [w.actor] : [], { db });
    return { proof: adminProof(row, { removal: w ? { at: w.at, by: w.actor, byName: nameOf(names, w.actor) } : null, nowMs: ms(now) }), alreadyRemoved };
  };
  let changed;
  try {
    changed = await db.$transaction(async (tx) => {
      const row = await tx.paymentProof.findUnique({ where: { id } });
      if (!row) throw err('NOT_FOUND', 'Preuve introuvable.');
      const prior = await tx.paymentProofEvent.findFirst({ where: { proofId: id, action: 'REMOVE' }, select: { id: true } });
      if (prior) return false;
      const res = await tx.paymentProof.updateMany({
        where: { id, status: { in: EDITABLE } },
        data: { status: PROOF_STATUS.CANCELLED, cancelledAt: now, updatedBy: actor },
      });
      const after = res.count === 1 ? null : await tx.paymentProof.findUnique({ where: { id } });
      const previous = res.count === 1 ? row.status : after.status;
      await event(tx, id, 'REMOVE', actor, now, {
        previousStatus: previous,
        cancelled: res.count === 1,
        wasVisible: res.count === 1 ? false : isVisibleAt(after, ms(now)),
      });
      return true;
    });
  } catch (e) {
    if (isUnique(e, 'proofId') || isUnique(e, 'remove')) return finish(true); // a concurrent "Supprimer" won
    throw e;
  }
  return finish(!changed);
}

/**
 * The ONE global affiliate feed: every proof whose display has not ended (visibleUntil, captured
 * at publication — legacy proofs: 72 h) and that was not removed, the same
 * for every active affiliate, ordered publishedAt DESC then publicToken ASC, served in
 * pages of FEED_PAGE_SIZE with a cursor — no cap, nothing is ever omitted.
 * Read-only (never publishes). → { proofs, total, nextCursor }
 */
export async function listVisiblePaymentProofs({ db = prisma, now = new Date(), cursor = null } = {}) {
  const c = decodeFeedCursor(cursor);
  if (c?.invalid) throw err('INVALID_INPUT', 'Curseur invalide.');
  const nowMs = ms(now);
  const windowWhere = visibleFeedWhere(now);
  const where = c
    ? { AND: [windowWhere, { OR: [{ publishedAt: { lt: new Date(c.publishedAtMs) } }, { publishedAt: new Date(c.publishedAtMs), publicToken: { gt: c.token } }] }] }
    : windowWhere;
  const size = PROOF_LIMITS.FEED_PAGE_SIZE;
  const [rows, total] = await Promise.all([
    db.paymentProof.findMany({
      where, orderBy: [{ publishedAt: 'desc' }, { publicToken: 'asc' }], take: size + 1,
      select: { publicToken: true, displayName: true, displayAmountCents: true, publishedAt: true, visibleUntil: true, status: true },
    }),
    db.paymentProof.count({ where: windowWhere }),
  ]);
  const page = rows.slice(0, size).filter((r) => isVisibleAt(r, nowMs)).map(publicProof);
  return { proofs: page, total, nextCursor: rows.length > size && page.length ? encodeFeedCursor(page[page.length - 1]) : null };
}

/** Receipt image for affiliates: only while the proof is visible; anything else → NOT_FOUND (no leak). */
export async function readVisiblePaymentProofImage(token, { db = prisma, storage = defaultPaymentProofStorage, now = new Date() } = {}) {
  if (!isValidPublicToken(token)) throw err('NOT_FOUND', 'Introuvable.');
  const row = await db.paymentProof.findUnique({ where: { publicToken: token }, select: { id: true, status: true, publishedAt: true, visibleUntil: true, fileKey: true } });
  if (!row || !isVisibleAt(row, ms(now))) throw err('NOT_FOUND', 'Introuvable.');
  const removed = await db.paymentProofEvent.findFirst({ where: { proofId: row.id, action: 'REMOVE' }, select: { id: true } });
  if (removed) throw err('NOT_FOUND', 'Introuvable.');
  const file = await storage.read(row.fileKey);
  if (!file) throw err('NOT_FOUND', 'Introuvable.');
  return file;
}

/** Receipt image for admins (any status). */
export async function readAdminPaymentProofImage(id, { db = prisma, storage = defaultPaymentProofStorage } = {}) {
  if (!isValidId(id)) throw err('NOT_FOUND', 'Introuvable.');
  const row = await db.paymentProof.findUnique({ where: { id }, select: { fileKey: true } });
  const file = row ? await storage.read(row.fileKey) : null;
  if (!file) throw err('NOT_FOUND', 'Introuvable.');
  return file;
}

/**
 * Admin list (paged) with status counts. Read-only. Removed proofs stay listed (history), with
 * `removed` / `removedAt` / `removedBy`; `onSlider` = shown to affiliates right now.
 */
export async function listPaymentProofsAdmin({ status = 'ALL', batchId = null, page = 1, db = prisma, now = new Date() } = {}) {
  const where = {};
  if (status !== 'ALL') {
    if (!Object.values(PROOF_STATUS).includes(status)) throw err('INVALID_INPUT', 'Statut invalide.');
    where.status = status;
  }
  if (batchId) {
    if (!isValidId(batchId)) throw err('INVALID_INPUT', 'Lot invalide.');
    where.batchId = batchId;
  }
  const size = PROOF_LIMITS.ADMIN_PAGE_SIZE;
  const pageNo = Number.isInteger(page) && page > 0 ? Math.min(page, 100_000) : 1;
  const [rows, total, groups, removedCount] = await Promise.all([
    db.paymentProof.findMany({ where, orderBy: [{ scheduledAt: 'desc' }, { id: 'asc' }], skip: (pageNo - 1) * size, take: size }),
    db.paymentProof.count({ where }),
    db.paymentProof.groupBy({ by: ['status'], _count: { _all: true } }),
    db.paymentProofEvent.count({ where: { action: 'REMOVE' } }),
  ]);
  const counts = Object.fromEntries(Object.values(PROOF_STATUS).map((s) => [s, 0]));
  for (const g of groups) counts[g.status] = g._count._all;
  counts.REMOVED = removedCount;
  // ONE event query for the page: published by "Publier maintenant"? (PUBLISH mode IMMEDIATE) and removed?
  const immediate = new Set();
  const removals = new Map();
  if (rows.length) {
    const evs = await db.paymentProofEvent.findMany({
      where: { proofId: { in: rows.map((r) => r.id) }, action: { in: ['PUBLISH', 'REMOVE'] } },
      select: { proofId: true, action: true, actor: true, at: true, details: true },
    });
    for (const e of evs) {
      if (e.action === 'PUBLISH' && e.details && e.details.mode === 'IMMEDIATE') immediate.add(e.proofId);
      if (e.action === 'REMOVE') removals.set(e.proofId, { at: e.at, by: e.actor });
    }
  }
  const nowMs = ms(now);
  const names = await resolveAdminNames([...removals.values()].map((x) => x.by), { db });
  for (const x of removals.values()) x.byName = nameOf(names, x.by);
  return {
    items: rows.map((r) => adminProof(r, { publishedImmediately: immediate.has(r.id), removal: removals.get(r.id) ?? null, nowMs })),
    total, page: pageNo, pageSize: size, counts,
  };
}

/** Audit history of one proof, in insertion order (`seq`; events of one transaction share `at`). */
export async function listPaymentProofEvents(id, { db = prisma } = {}) {
  if (!isValidId(id)) throw err('NOT_FOUND', 'Preuve introuvable.');
  const proof = await db.paymentProof.findUnique({ where: { id }, select: { id: true } });
  if (!proof) throw err('NOT_FOUND', 'Preuve introuvable.');
  const rows = await db.paymentProofEvent.findMany({ where: { proofId: id }, orderBy: [{ seq: 'asc' }] });
  // actorName: display name of the admin (or "Publication automatique" / "Administrateur"); the stored actor is unchanged.
  const names = await resolveAdminNames(rows.map((e) => e.actor), { db });
  return { events: rows.map((e) => ({ action: e.action, actor: e.actor, actorName: nameOf(names, e.actor), at: new Date(e.at).toISOString(), details: e.details ?? null })) };
}
