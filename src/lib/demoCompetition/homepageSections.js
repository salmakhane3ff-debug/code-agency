/**
 * src/lib/demoCompetition/homepageSections.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure helpers used by /admin/demo-competition/homepage to edit the two Demo
 * Competition sections ("top_members", "top_brands") inside the EXISTING
 * homepage builder layout (Setting row `homepage_layout`, shape
 * { sections: [{ id: "sec_<ts>_<n>", type, visible, data }] }).
 *
 * Every function returns a NEW array and never removes, reorders (other than the
 * one requested move) or alters any other section. When a type appears several
 * times (the builder allows duplicates) the FIRST occurrence is the one edited.
 *
 * No React, no I/O: safe to import in client components and unit-test in node.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The two homepage section types managed here, with their preview-count bounds. */
export const DEMO_HOMEPAGE_TYPES = Object.freeze({
  top_members: Object.freeze({ type: 'top_members', label: 'Top Members', min: 1, max: 21, defaultCount: 5 }),
  top_brands: Object.freeze({ type: 'top_brands', label: 'Top Brands', min: 1, max: 20, defaultCount: 5 }),
});

export const TITLE_MAX = 80;

const metaOf = (type) => {
  const m = DEMO_HOMEPAGE_TYPES[type];
  if (!m) throw new Error(`Unsupported demo homepage section type: ${type}`);
  return m;
};

/** Normalized sections array (anything that is not an array → []). */
export const asSections = (v) => (Array.isArray(v) ? v : []);

/** Index of the first section of `type`, or -1. */
export function findSectionIndex(sections, type) {
  return asSections(sections).findIndex((s) => s && s.type === type);
}

/** Number of sections of `type` (duplicates are possible in the builder). */
export function countSections(sections, type) {
  return asSections(sections).filter((s) => s && s.type === type).length;
}

/** Clamp a preview count into [min, max] of the type (non-numbers → the default). */
export function clampPreviewCount(type, value) {
  const m = metaOf(type);
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return m.defaultCount;
  return Math.min(m.max, Math.max(m.min, Math.round(n)));
}

/** Section id in the builder's format: sec_<timestamp>_<n>. */
export const sectionId = (nowMs, seq) => `sec_${nowMs}_${seq}`;

/** Default `data` of a newly added section. */
export function defaultSectionData(type) {
  const m = metaOf(type);
  return { title: '', previewCount: m.defaultCount, showViewAll: true };
}

/**
 * Append a section of `type` at the END of the layout when there is none yet.
 * Existing layouts are returned unchanged (same array) when the type is already present.
 */
export function addSection(sections, type, { nowMs = Date.now(), seq = 1 } = {}) {
  metaOf(type);
  const list = asSections(sections);
  if (findSectionIndex(list, type) !== -1) return list;
  const taken = new Set(list.map((s) => s?.id));
  let n = seq;
  while (taken.has(sectionId(nowMs, n))) n += 1;
  return [...list, { id: sectionId(nowMs, n), type, visible: true, data: defaultSectionData(type) }];
}

/** Show / hide the first section of `type` (no-op when absent). */
export function setSectionVisible(sections, type, visible) {
  metaOf(type);
  const list = asSections(sections);
  const i = findSectionIndex(list, type);
  if (i === -1) return list;
  return list.map((s, j) => (j === i ? { ...s, visible: !!visible } : s));
}

/** Move the first section of `type` one step up (dir = -1) or down (dir = +1) in the overall order. */
export function moveSection(sections, type, dir) {
  metaOf(type);
  const list = asSections(sections);
  const i = findSectionIndex(list, type);
  const j = i + (dir < 0 ? -1 : 1);
  if (i === -1 || j < 0 || j >= list.length) return list;
  const a = [...list];
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}

/**
 * Merge `patch` into the data of the first section of `type`. Only the keys
 * { title, previewCount, showViewAll } are written (clamped / normalized); any
 * other key already present in `data` is kept as is.
 */
export function updateSectionData(sections, type, patch = {}) {
  metaOf(type);
  const list = asSections(sections);
  const i = findSectionIndex(list, type);
  if (i === -1) return list;
  const next = {};
  if (patch.title !== undefined) next.title = String(patch.title ?? '').replace(/\s+/g, ' ').trimStart().slice(0, TITLE_MAX);
  if (patch.previewCount !== undefined) next.previewCount = clampPreviewCount(type, patch.previewCount);
  if (patch.showViewAll !== undefined) next.showViewAll = !!patch.showViewAll;
  return list.map((s, j) => (j === i ? { ...s, data: { ...(s.data && typeof s.data === 'object' ? s.data : {}), ...next } } : s));
}

/** Final cleanup before saving: trims the titles of the managed sections (others untouched). */
export function finalizeSections(sections) {
  return asSections(sections).map((s) => {
    if (!s || !DEMO_HOMEPAGE_TYPES[s.type] || typeof s.data?.title !== 'string') return s;
    const title = s.data.title.trim();
    return title === s.data.title ? s : { ...s, data: { ...s.data, title } };
  });
}

/**
 * Read-only view of the first section of `type` for the admin UI:
 * { present, index, total, visible, title, previewCount, showViewAll, prevType, nextType, duplicates }.
 */
export function describeSection(sections, type) {
  const m = metaOf(type);
  const list = asSections(sections);
  const i = findSectionIndex(list, type);
  if (i === -1) return { present: false, index: -1, total: list.length, duplicates: 0 };
  const s = list[i];
  const d = s.data && typeof s.data === 'object' ? s.data : {};
  return {
    present: true,
    index: i,
    total: list.length,
    visible: s.visible !== false,
    title: typeof d.title === 'string' ? d.title : '',
    previewCount: d.previewCount === undefined ? m.defaultCount : clampPreviewCount(type, d.previewCount),
    showViewAll: d.showViewAll === undefined ? true : !!d.showViewAll,
    prevType: i > 0 ? list[i - 1]?.type ?? null : null,
    nextType: i < list.length - 1 ? list[i + 1]?.type ?? null : null,
    duplicates: countSections(list, type) - 1,
  };
}

/**
 * True when `after` differs from `before` ONLY in sections of the managed types
 * (every other section keeps its id, type, visible flag, data and relative order).
 */
export function preservesOtherSections(before, after) {
  const others = (l) => asSections(l).filter((s) => !s || !DEMO_HOMEPAGE_TYPES[s.type]).map((s) => JSON.stringify(s));
  const a = others(before), b = others(after);
  return a.length === b.length && a.every((x, k) => x === b[k]);
}
