/**
 * src/lib/demoProfileValidation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, client-safe validation for DEMO competition profiles (Phase 3B) — fake
 * personas only, never real affiliates. Returns { ok, value } / { ok, field, error }.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PROFILE_META_PREFIX = 'demo-profile-meta:';
export const DEMO_GENDERS = ['men', 'women'];
export const DEMO_GROWTH_TYPES = ['aggressive', 'consistent', 'slow'];
export const HISTORY_DAYS = 90;
export const MAX_GENERATE = 100;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const isValidProfileId = (id) => typeof id === 'string' && ID_RE.test(id);

const fail = (field, error) => ({ ok: false, field, error });

/**
 * Profile fields an admin may set. `partial` = PATCH (only sent keys);
 * otherwise name + username are required (create).
 * `avatarAllowed(url)` decides whether a non-null avatarUrl is acceptable.
 */
export function validateProfileInput(body, { partial = false, avatarAllowed = () => false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(null, 'Données invalides');
  const allowed = ['name', 'username', 'avatarUrl', 'avatarColor', 'gender', 'growthType', 'city', 'isActive'];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return fail(unknown[0], `Champ non modifiable : ${unknown[0]}`);

  const out = {};
  const has = (k) => body[k] !== undefined;

  if (has('name') || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 60) return fail('name', 'Nom : 2 à 60 caractères.');
    out.name = name;
  }
  if (has('username') || !partial) {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) return fail('username', "Nom d'utilisateur : 3 à 30 caractères (a-z, 0-9, _ .).");
    out.username = username;
  }
  if (has('avatarUrl')) {
    if (body.avatarUrl === null || body.avatarUrl === '') out.avatarUrl = null;
    else if (typeof body.avatarUrl === 'string' && avatarAllowed(body.avatarUrl)) out.avatarUrl = body.avatarUrl;
    else return fail('avatarUrl', "Avatar : choisissez une image de la bibliothèque démo (ou aucune).");
  }
  if (has('avatarColor')) {
    if (typeof body.avatarColor !== 'string' || !COLOR_RE.test(body.avatarColor)) return fail('avatarColor', 'Couleur : format #RRGGBB.');
    out.avatarColor = body.avatarColor;
  }
  if (has('gender')) {
    if (!DEMO_GENDERS.includes(body.gender)) return fail('gender', 'Genre : men ou women.');
    out.gender = body.gender;
  }
  if (has('growthType')) {
    if (!DEMO_GROWTH_TYPES.includes(body.growthType)) return fail('growthType', 'Profil de croissance : aggressive, consistent ou slow.');
    out.growthType = body.growthType;
  }
  if (has('city')) {
    if (body.city !== null && typeof body.city !== 'string') return fail('city', 'Ville invalide.');
    const city = (body.city || '').trim();
    if (city.length > 60) return fail('city', 'Ville : 60 caractères maximum.');
    out.city = city || null;
  }
  if (has('isActive')) {
    if (typeof body.isActive !== 'boolean') return fail('isActive', 'Statut : true ou false.');
    out.isActive = body.isActive;
  }
  if (partial && Object.keys(out).length === 0) return fail(null, 'Aucun champ à modifier.');
  return { ok: true, value: out };
}

/** Generation request: { count 1..100, mode, strategy 'target' | 'add' }. */
export function validateGenerateInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const count = Number(b.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATE) return fail('count', `Nombre : entier de 1 à ${MAX_GENERATE}.`);
  const mode = ['men', 'women', 'mixed'].includes(b.mode) ? b.mode : 'mixed';
  const strategy = b.strategy === 'add' ? 'add' : 'target';
  return { ok: true, value: { count, mode, strategy } };
}

/** History entry edit: whole orders 0..10 000, revenue 0..10 000 000 (2 dp). */
export function validateHistoryEdit(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!isValidProfileId(b.historyId)) return fail('historyId', 'Entrée invalide.');
  const orders = b.orders;
  if (!Number.isInteger(orders) || orders < 0 || orders > 10000) return fail('orders', 'Commandes : entier de 0 à 10 000.');
  const revenue = b.revenue;
  if (typeof revenue !== 'number' || !Number.isFinite(revenue) || revenue < 0 || revenue > 1e7) return fail('revenue', "Chiffre d'affaires : montant de 0 à 10 000 000.");
  if (orders === 0 && revenue > 0) return fail('revenue', "Chiffre d'affaires : 0 quand il n'y a aucune commande.");
  return { ok: true, value: { historyId: b.historyId, orders, revenue: Math.round(revenue * 100) / 100 } };
}

/** Chat extension point (Phase 3C): always reported as NOT enabled in Phase 3B. */
export function normalizeChatConfig(raw) {
  const journeyId = raw && typeof raw.journeyId === 'string' && raw.journeyId ? raw.journeyId : null;
  return { journeyId, enabled: false };
}
