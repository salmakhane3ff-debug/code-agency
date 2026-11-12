/**
 * src/lib/demoCompetition/disclosure.js
 * ─────────────────────────────────────────────────────────────────────────────
 * THE single source of the simulation disclosure of the Top Members / Top Brands
 * leaderboards (affiliate dashboard block, /top-members, /top-brands and the
 * member / brand profiles, and their page metadata).
 *
 * While the leaderboard data is simulated, keep `enabled: true`: visitors must be
 * told that the rankings are not real sales or earnings. To change the wording,
 * edit `text` (FR + AR) here — nowhere else. To stop showing it (e.g. once the
 * leaderboards run on real data), set `enabled` to false: <SimulationNote> then
 * renders nothing and the page descriptions drop the sentence.
 *
 * Pure (no React, no server-only import): used by client components and by the
 * server page metadata. scripts/demoCompetitionPublic.test.mjs checks that these
 * sentences appear in no other src file.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const SIMULATION_DISCLOSURE = Object.freeze({
  enabled: true,
  text: Object.freeze({
    fr: "Classement basé sur des données simulées : il ne s'agit ni de ventes ni de gains réels.",
    ar: "ترتيب مبني على بيانات محاكاة: ليست مبيعات ولا أرباحاً حقيقية.",
  }),
});

/** Disclosure sentence for `lang` ('ar' | anything else → 'fr'), or null when disabled / empty. */
export function simulationDisclosure(lang, config = SIMULATION_DISCLOSURE) {
  if (!config || !config.enabled) return null;
  const text = config.text?.[lang === "ar" ? "ar" : "fr"];
  return typeof text === "string" && text.trim() ? text : null;
}

/** Neutral page metadata (French, as the rest of the storefront metadata). */
const PAGE_METADATA = Object.freeze({
  members: Object.freeze({ title: "Top Membres", description: "Classement des membres sur 30 jours glissants." }),
  brands: Object.freeze({ title: "Top Marques", description: "Classement des marques sur 30 jours glissants." }),
  member: Object.freeze({ title: "Profil membre", description: "Profil d'un membre du Top Membres." }),
  brand: Object.freeze({ title: "Profil marque", description: "Profil d'une marque du Top Marques." }),
});

/** Next.js `metadata` of a public leaderboard page: 'members' | 'brands' | 'member' | 'brand'. */
export function demoPageMetadata(kind, config = SIMULATION_DISCLOSURE) {
  const base = PAGE_METADATA[kind];
  if (!base) throw new Error(`Unknown leaderboard page: ${kind}`);
  const note = simulationDisclosure("fr", config);
  return { title: base.title, description: note ? `${base.description} ${note}` : base.description };
}
