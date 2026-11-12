/**
 * src/lib/services/adminNameService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Display names for the actors recorded in admin audit / history entries (payment-proof
 * events, the payment-proof display-duration history, the "Recharge de solde des Affiliés"
 * switch history). Those records store the acting admin's user id (JWT userId) — or, for
 * old tokens without an id, the e-mail — and the publication worker's tag.
 *
 * READ-ONLY and display-only: the stored records are never changed. Only the account's
 * `name` is ever returned (never its e-mail, role, or any other field), so a label can be
 * shown without exposing more about the account. Fallbacks:
 *   • the publication worker → "Publication automatique";
 *   • unknown / deleted account, empty name, or a lookup error → "Administrateur".
 * One query per call (batched), whatever the number of entries.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';

export const ADMIN_NAME_FALLBACK = 'Administrateur';
export const SYSTEM_ACTOR_LABELS = Object.freeze({
  'worker:payment-proofs-publisher': 'Publication automatique',
});
const MAX_NAME = 80;

const cleanName = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_NAME) : null;
};

/**
 * actors (array of stored actor strings, duplicates / nulls allowed) → Map(actor → label).
 * Every distinct non-empty actor gets a label; nothing throws (a failed lookup → fallbacks).
 */
export async function resolveAdminNames(actors, { db = prisma } = {}) {
  const list = [...new Set((actors || []).filter((a) => typeof a === 'string' && a))];
  const out = new Map();
  const toLookUp = [];
  for (const a of list) {
    if (SYSTEM_ACTOR_LABELS[a]) out.set(a, SYSTEM_ACTOR_LABELS[a]);
    else toLookUp.push(a);
  }
  if (toLookUp.length) {
    const ids = toLookUp.filter((a) => !a.includes('@'));
    const emails = toLookUp.filter((a) => a.includes('@'));
    let users = [];
    try {
      if (typeof db?.user?.findMany === 'function') {
        users = await db.user.findMany({
          where: { OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(emails.length ? [{ email: { in: emails } }] : [])] },
          select: { id: true, email: true, name: true },
        });
      }
    } catch {
      users = []; // display only: never break an audit view because of a name lookup
    }
    const byId = new Map(users.map((u) => [u.id, cleanName(u.name)]));
    const byEmail = new Map(users.map((u) => [u.email, cleanName(u.name)]));
    for (const a of toLookUp) out.set(a, (a.includes('@') ? byEmail.get(a) : byId.get(a)) || ADMIN_NAME_FALLBACK);
  }
  return out;
}

/** Label of one actor from a resolved map (null when there is no actor at all). */
export const nameOf = (names, actor) => (actor ? names.get(actor) || ADMIN_NAME_FALLBACK : null);
