#!/usr/bin/env node
/**
 * scripts/homepageLayout.test.mjs — conflict-safe homepage layout writes (Homepage Builder ↔ Demo Competition
 * Homepage Settings): revision check, no silent overwrite, generic POST refused, route auth.
 *
 *   node scripts/homepageLayout.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  getHomepageLayout, saveHomepageLayout, homepageLayoutHandlers, layoutRevision, validSections, LAYOUT_LIMITS,
} from '../src/lib/services/homepageLayoutService.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (f) => readFileSync(`${ROOT}${f}`, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`); } };

/** Minimal fake: settings rows + serialised transactions (like the advisory lock) + lock log. */
function fakeDb(initial = null) {
  const rows = new Map(initial ? [['homepage_layout', structuredClone(initial)]] : []);
  const locks = [];
  let chain = Promise.resolve();
  const setting = {
    findUnique: async ({ where }) => (rows.has(where.id) ? { id: where.id, data: structuredClone(rows.get(where.id)) } : null),
    upsert: async ({ where, update, create }) => {
      rows.set(where.id, structuredClone(rows.has(where.id) ? update.data : create.data));
      return { id: where.id, data: structuredClone(rows.get(where.id)) };
    },
  };
  const tx = { setting, $executeRaw: async (strings, ...values) => { locks.push(values.join(',')); return 1; } };
  return {
    setting, rows, locks,
    $transaction: (fn) => {
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => {});
      return run;
    },
  };
}

const S = (id, type = 'products', extra = {}) => ({ id, type, visible: true, data: {}, ...extra });
const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

console.log('\n1. Read');
{
  const empty = fakeDb();
  const r0 = await getHomepageLayout({ db: empty });
  ok('no custom layout yet → sections null + a revision', r0.sections === null && typeof r0.revision === 'string' && r0.revision.length === 32);
  const db = fakeDb({ sections: [S('a'), S('b', 'top_members')] });
  const r = await getHomepageLayout({ db });
  ok('stored layout → its sections and the revision of the stored row', r.sections.length === 2 && r.revision === layoutRevision({ sections: [S('a'), S('b', 'top_members')] }));
}

console.log('\n2. Save with revision');
{
  const db = fakeDb({ sections: [S('a')], other: 'kept' });
  const { revision } = await getHomepageLayout({ db });
  const saved = await saveHomepageLayout({ db }, { sections: [S('a'), S('m', 'top_members')], revision });
  ok('matching revision → saved, new revision returned', saved.sections.length === 2 && saved.revision !== revision && db.rows.get('homepage_layout').sections.length === 2);
  ok('other keys of the row are kept', db.rows.get('homepage_layout').other === 'kept');
  ok('the save took the layout advisory lock', db.locks.includes('homepage-layout'));
  const stale = await code(saveHomepageLayout({ db }, { sections: [S('a')], revision }));
  ok('stale revision (someone saved in between) → LAYOUT_CONFLICT, nothing written', stale === 'LAYOUT_CONFLICT' && db.rows.get('homepage_layout').sections.length === 2);
  try { await saveHomepageLayout({ db }, { sections: [S('z')], revision }); } catch (e) {
    ok('the conflict carries the CURRENT sections + revision (the page reloads them)', e.status === 409 && e.extra.sections.length === 2 && e.extra.revision === saved.revision);
  }
  const first = await getHomepageLayout({ db: fakeDb() });
  const fresh = fakeDb();
  await saveHomepageLayout({ db: fresh }, { sections: [S('x')], revision: first.revision });
  ok('first ever save (no row) works with the "no layout" revision', fresh.rows.get('homepage_layout').sections[0].id === 'x');
}

console.log('\n3. Two pages saving from the same loaded revision (the overwrite scenario)');
{
  const db = fakeDb({ sections: [S('slider', 'slider'), S('m', 'top_members', { data: { title: 'Avant' } })] });
  const loaded = await getHomepageLayout({ db }); // both pages opened → same revision
  const demoPage = saveHomepageLayout({ db }, { sections: [S('slider', 'slider'), S('m', 'top_members', { data: { title: 'Top 5' } })], revision: loaded.revision });
  const builder = saveHomepageLayout({ db }, { sections: [S('slider', 'slider'), S('m', 'top_members', { data: { title: 'Avant' } }), S('p')], revision: loaded.revision });
  const res = await Promise.allSettled([demoPage, builder]);
  ok('exactly one save wins; the other gets LAYOUT_CONFLICT (no silent overwrite)', res.filter((r) => r.status === 'fulfilled').length === 1
    && res.filter((r) => r.status === 'rejected' && r.reason.code === 'LAYOUT_CONFLICT').length === 1);
  ok('the stored layout is the winner\'s, intact', db.rows.get('homepage_layout').sections.find((x) => x.id === 'm').data.title === 'Top 5'
    && db.rows.get('homepage_layout').sections.length === 2);
}

console.log('\n4. Validation');
{
  ok('valid sections accepted', validSections([S('a'), S('b', 'top_brands', { visible: false })]));
  ok('not an array / duplicate ids / missing type / bad visible / bad data refused', !validSections({}) && !validSections([S('a'), S('a')])
    && !validSections([{ id: 'a' }]) && !validSections([S('a', 'x', { visible: 'yes' })]) && !validSections([S('a', 'x', { data: [] })]) && !validSections([S('a', 'bad type!')]));
  ok(`too many sections (> ${LAYOUT_LIMITS.maxSections}) or too large refused`, !validSections(Array.from({ length: 101 }, (_, i) => S(`s${i}`)))
    && !validSections([S('a', 'x', { data: { big: 'x'.repeat(LAYOUT_LIMITS.maxBytes) } })]));
  const db = fakeDb();
  ok('save without a revision → INVALID_LAYOUT', await code(saveHomepageLayout({ db }, { sections: [S('a')] })) === 'INVALID_LAYOUT');
}

console.log('\n5. Route handlers');
{
  const db = fakeDb({ sections: [S('a')] });
  const h = homepageLayoutHandlers({ db });
  let r = await h.get();
  const g = await r.json();
  ok('GET → 200, no-store, { sections, revision }', r.status === 200 && r.headers.get('cache-control') === 'no-store' && g.sections.length === 1 && g.revision);
  const put = (body) => h.put(new Request('http://x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  r = await put({ sections: [S('a'), S('b')], revision: g.revision });
  const p1 = await r.json();
  ok('PUT with the current revision → 200 + new revision', r.status === 200 && p1.revision !== g.revision);
  r = await put({ sections: [S('c')], revision: g.revision });
  const c = await r.json();
  ok('PUT with a stale revision → 409 LAYOUT_CONFLICT + current state', r.status === 409 && c.code === 'LAYOUT_CONFLICT' && c.revision === p1.revision && c.sections.length === 2);
  r = await put('not json');
  ok('malformed body → 400 INVALID_LAYOUT', r.status === 400 && (await r.json()).code === 'INVALID_LAYOUT');
}

console.log('\n6. Wiring');
{
  const route = read('src/app/api/admin/homepage-layout/route.js');
  ok('the route is admin-only (withAdminAuth on GET and PUT) and dynamic', /export const GET = withAdminAuth\(h\.get\);/.test(route) && /export const PUT = withAdminAuth\(h\.put\);/.test(route)
    && /export const dynamic = "force-dynamic";/.test(route));
  const { upsertSettingsHandler } = await import('../src/lib/controllers/settingsController.js');
  const res = await upsertSettingsHandler(new Request('http://x/api/setting?type=homepage_layout', { method: 'POST', body: JSON.stringify({ sections: [] }) }));
  ok('the generic POST /api/setting?type=homepage_layout is refused (reserved: no blind overwrite path left)', res.status === 400);
  const builder = read('src/app/admin/homepage-builder/page.jsx'), demoHome = read('src/app/admin/demo-competition/homepage/page.jsx');
  ok('both admin pages write only through /api/admin/homepage-layout (PUT with revision)', [builder, demoHome].every((src) => /\/api\/admin\/homepage-layout/.test(src) && /revision/.test(src) && !/method:\s*"POST"[\s\S]{0,120}homepage_layout|homepage_layout[\s\S]{0,200}method:\s*"POST"/.test(src)));
  ok('the public homepage still reads GET /api/setting?type=homepage_layout (unchanged)', /fetch\("\/api\/setting\?type=homepage_layout"/.test(read('src/app/page.jsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
