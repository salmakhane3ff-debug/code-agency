/**
 * Top-3 highlight classes, keyed on the CURRENT rank only: when the leaders change, the
 * highlight moves with them. In the approved design they draw a SUBTLE glow (1 gold,
 * 2 silver, 3 bronze) — the historical "flame" class names are kept. Pure — the visuals
 * live in demoCompetition.css.
 */
export const FLAME_RANKS = Object.freeze([1, 2, 3]);

/** "dc-flame dc-flame--N" for ranks 1..3, "" otherwise. */
export function flameClass(rank) {
  return FLAME_RANKS.includes(rank) ? `dc-flame dc-flame--${rank}` : "";
}

/** Extra top margin above the #1 row for its crown. */
export function flameSpaceClass(rank) {
  return FLAME_RANKS.includes(rank) ? `dc-flame-space--${rank}` : "";
}
