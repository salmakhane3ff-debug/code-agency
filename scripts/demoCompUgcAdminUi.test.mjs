#!/usr/bin/env node
/**
 * scripts/demoCompUgcAdminUi.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition — UGC Videos ADMIN UI (SIMULATION ONLY): static checks of
 * src/app/admin/demo-competition/ugc-videos/** + the hub navigation, plus the
 * pure helpers of those files evaluated from their own source, and a contract
 * check of the real admin handlers (fake DB) against the keys the UI reads.
 * Proves:
 *   1. navigation: the hub lists Members (affiliates), Brands, UGC Videos in that
 *      order, Live Engine / Homepage Settings unchanged after them
 *   2. the page + components exist (client components, default export)
 *   3. every request goes through dcApi to the documented /ugc-videos endpoints
 *      (GET/PATCH state, POST /videos, GET/PATCH /videos/{id}, archive, restore,
 *      uploads, /run, /generate); no direct fetch / XHR; no DELETE anywhere
 *   4. FormData uploads (field "file") never set a Content-Type: dcApi is executed
 *      with a recording fetch → no Content-Type, fetch derives multipart + boundary;
 *      JSON keeps application/json
 *   5. client-side upload pre-check (checkUgcFile) from the `uploads` spec
 *   6. reward select only 5 / 6 / 7; the form validation mirrors the server codes
 *   7. video previews: controls, never autoplay
 *   8. every documented error code (top-level + fields, and every code the service
 *      can actually emit) has a French label
 *   9. SIMULATION / DÉMO marking; archive = "Retirer" with confirm (history kept,
 *      restorable) + Restore; data attributes for tests; mobile layout guards
 *  10. contract: GET state / GET video / generate / run payloads of the real admin
 *      handlers carry every key the UI reads
 * Run: node scripts/demoCompUgcAdminUi.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from '../src/lib/demoCompUgc.js';
import * as svc from '../src/lib/services/demoCompUgcService.js';
import { makeUgcFakeDb } from './lib/demoCompUgcFakeDb.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ` ${JSON.stringify(extra).slice(0, 600)}` : ''}`); }
};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const DIR = 'src/app/admin/demo-competition';
const UDIR = `${DIR}/ugc-videos`;
const PAGE = `${UDIR}/page.jsx`, EDITOR = `${UDIR}/_components/VideoEditor.jsx`, UI = `${UDIR}/_components/ugcUi.jsx`;
const walk = (d) => readdirSync(join(ROOT, d)).flatMap((n) => (statSync(join(ROOT, d, n)).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]));

/** `function name(…) { … }` (balanced braces) from a source file. */
function extractFn(src, name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(src);
  if (!m) return null;
  const open = src.indexOf('{', src.indexOf(')', m.index));
  for (let i = open, depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  return null;
}
/** `export const NAME = { … };` object literal (plain strings only) evaluated. */
function extractObject(src, name) {
  const m = new RegExp(`export const ${name} = (\\{[\\s\\S]*?\\n\\});`).exec(src);
  return m ? new Function(`return ${m[1]};`)() : null;
}

// ── 1. Navigation ─────────────────────────────────────────────────────────────
console.log('\n1. Navigation (Demo Competition hub)');
{
  const hub = read(`${DIR}/page.jsx`);
  const hrefs = [...hub.matchAll(/href: "(\/admin\/demo-competition\/[\w-]+)"/g)].map((m) => m[1]);
  ok('hub entries: Members (affiliates) → Brands → UGC Videos → Live Engine → Homepage Settings',
    eq(hrefs, ['members', 'brands', 'ugc-videos', 'engine', 'homepage'].map((p) => `/admin/demo-competition/${p}`)), hrefs);
  ok('the UGC entry is labelled "Demo UGC Videos" and says it is simulated', /href: "\/admin\/demo-competition\/ugc-videos", icon: \w+, title: "Demo UGC Videos", desc: "[^"]*simulées/.test(hub));
  ok('members / brands entries unchanged', /title: "Demo Members"/.test(hub) && /title: "Demo Brands"/.test(hub) && /title: "Live Engine"/.test(hub) && /title: "Homepage Settings"/.test(hub));
}

// ── 2. Files ──────────────────────────────────────────────────────────────────
console.log('\n2. Files');
for (const f of [PAGE, EDITOR, UI]) ok(`${f} exists, "use client"`, existsSync(join(ROOT, f)) && /^"use client";/.test(read(f)));
ok('page + editor have a default export', /export default function DemoUgcVideosPage\(/.test(read(PAGE)) && /export default function VideoEditor\(/.test(read(EDITOR)));
const files = walk(UDIR).filter((f) => /\.(jsx?|mjs)$/.test(f));
const all = files.map(read).join('\n');
const page = read(PAGE), editor = read(EDITOR), ui = read(UI);
{
  const missing = [];
  const exportsOf = (rel) => {
    const s = read(rel);
    const names = new Set([...s.matchAll(/export (?:async )?(?:function|const|let|class) (\w+)/g)].map((m) => m[1]));
    for (const m of s.matchAll(/export \{([^}]+)\}/g)) for (const n of m[1].split(',')) names.add(n.trim().split(/\s+as\s+/).pop());
    return names;
  };
  for (const f of files) {
    for (const m of read(f).matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) {
      const base = m[2].startsWith('@/') ? `src/${m[2].slice(2)}` : m[2].startsWith('.') ? join(dirname(f), m[2]) : null;
      if (!base) continue;
      const file = ['.jsx', '.js', ''].map((x) => base + x).find((p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile());
      if (!file) { missing.push(`${f}: ${m[2]}`); continue; }
      const ex = exportsOf(file);
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) if (!ex.has(n)) missing.push(`${f}: ${n} from ${m[2]}`);
    }
  }
  ok('every named import from local / @ modules exists', missing.length === 0, missing);
  ok('no Prisma / service import in the client files', !/prisma|services\/|routeHandlers/.test(all));
}

// ── 3. Requests ───────────────────────────────────────────────────────────────
console.log('\n3. Requests (dcApi → /api/admin/demo-competition/ugc-videos/*)');
{
  ok('UGC path prefix is exactly "/ugc-videos" (relative to dcApi\'s API_BASE)', /export const UGC = "\/ugc-videos";/.test(ui)
    && /export const API_BASE = "\/api\/admin\/demo-competition";/.test(read(`${DIR}/_components/ui.jsx`)));
  ok('no direct fetch / XMLHttpRequest / hard-coded /api/ URL in the UGC files', !/\bfetch\(/.test(all) && !/XMLHttpRequest/.test(all) && !/\/api\//.test(all));
  const calls = [...all.matchAll(/\bdcApi\(\s*([^,)]+?)\s*(?:,\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})?\s*\)/g)]
    .map((m) => ({ path: m[1].replace(/\$\{UGC\}/g, '/ugc-videos').replace(/^UGC$/, '"/ugc-videos"'), opts: m[2] || '', method: /method: "(\w+)"/.exec(m[2] || '')?.[1] || 'GET' }));
  const has = (method, path, bodyRe) => calls.some((c) => c.method === method && c.path === path && (!bodyRe || bodyRe.test(c.opts)));
  ok('GET state: dcApi(UGC)', has('GET', '"/ugc-videos"'), calls);
  ok('PATCH state { enabled } (module switch)', has('PATCH', '"/ugc-videos"', /body: \{ enabled: !enabled \}/));
  ok('PATCH state { targetVideoCount }', has('PATCH', '"/ugc-videos"', /body: \{ targetVideoCount: n \}/));
  ok('POST /generate and POST /run', has('POST', '`/ugc-videos/generate`') && has('POST', '`/ugc-videos/run`'));
  ok('POST /videos (create) with the form payload', has('POST', '`/ugc-videos/videos`', /body: payload/));
  ok('GET + PATCH /videos/{id} (editor)', has('GET', '`/ugc-videos/videos/${id}`') && has('PATCH', '`/ugc-videos/videos/${id}`', /body: payload/));
  ok('quick toggle: PATCH /videos/{id} { active: !v.active }', has('PATCH', '`/ugc-videos/videos/${v.id}`', /body: \{ active: !v\.active \}/));
  ok('archive + restore are POSTs (list and editor)', ['`/ugc-videos/videos/${v.id}/archive`', '`/ugc-videos/videos/${v.id}/restore`', '`/ugc-videos/videos/${id}/archive`', '`/ugc-videos/videos/${id}/restore`'].every((p) => has('POST', p)));
  ok('uploads: POST dcApi(path, { method: "POST", form }), path = /videos/{id}/{kind} or /upload/{kind} (pre-creation)',
    has('POST', 'path', /^\s*method: "POST", form\s*$/)
    && /const mediaPath = \(kind\) => \(creating \? `\$\{UGC\}\/upload\/\$\{kind\}` : `\$\{UGC\}\/videos\/\$\{id\}\/\$\{kind\}`\);/.test(editor)
    && /kind="video" path=\{mediaPath\("video"\)\}/.test(editor) && /kind="thumbnail" path=\{mediaPath\("thumbnail"\)\}/.test(editor));
  ok(`every dcApi call targets /ugc-videos (${calls.length} calls)`, calls.length >= 13 && calls.every((c) => c.path === 'path' || /^["`]\/ugc-videos/.test(c.path)), calls.map((c) => c.path));
  ok('every method is GET / PATCH / POST', calls.every((c) => ['GET', 'PATCH', 'POST'].includes(c.method)));
  ok('no DELETE request / delete UI anywhere (UGC files + hub)', !/["'`]DELETE["'`]/.test(all + read(`${DIR}/page.jsx`)) && !/method:\s*"DELETE"/i.test(all) && !/Trash2|Supprimer définitivement/.test(all));
}

// ── 4. Multipart uploads never set Content-Type ──────────────────────────────
console.log('\n4. FormData uploads (no hand-set Content-Type)');
{
  ok('upload: const form = new FormData(); form.append("file", file); dcApi(path, { method: "POST", form })',
    /const form = new FormData\(\);\s*form\.append\("file", file\);\s*const r = await dcApi\(path, \{ method: "POST", form \}\);/.test(ui));
  ok('no hand-set headers / "Content-Type" / "multipart/form-data" literal / setRequestHeader in the UGC files',
    !/\bheaders\s*:/.test(all) && !/["'`]content-type["'`]/i.test(all) && !/["'`]multipart\/form-data/i.test(all) && !/setRequestHeader/.test(all));
  const src = read(`${DIR}/_components/ui.jsx`).replace(/\bexport\s+/g, '');
  const code = extractFn(src, 'dcApi');
  const seen = [];
  const fakeFetch = async (url, init = {}) => { seen.push({ url, init }); return new Response('{"url":"/uploads/demo-competition-ugc/a.mp4"}', { status: 201, headers: { 'content-type': 'application/json' } }); };
  const dcApi = new Function('fetch', 'API_BASE', 'STATUS_TEXT', 'CODE_TEXT', 'normalizeFields', `return async ${code};`)(fakeFetch, '/api/admin/demo-competition', {}, {}, () => ({}));
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' }), 'clip.mp4');
  const up = await dcApi('/ugc-videos/upload/video', { method: 'POST', form: fd });
  await dcApi('/ugc-videos', { method: 'PATCH', body: { enabled: true } });
  const [u, j] = seen;
  ok('dcApi(FormData) → URL /api/admin/demo-competition/ugc-videos/upload/video, body is the FormData, NO Content-Type',
    u?.url === '/api/admin/demo-competition/ugc-videos/upload/video' && u.init.body === fd && !new Headers(u.init.headers || {}).has('content-type') && up.ok && up.data.url, u?.init?.headers);
  const req = new Request('http://local.test/u', { method: 'POST', headers: u?.init?.headers, body: u?.init?.body });
  ok('fetch derives multipart/form-data WITH a boundary', /^multipart\/form-data; boundary=/.test(req.headers.get('content-type') || ''));
  ok('dcApi(JSON) keeps Content-Type application/json and a JSON body', new Headers(j?.init?.headers || {}).get('content-type') === 'application/json' && j.init.body === '{"enabled":true}' && j.init.method === 'PATCH');
}

// ── 5. Client-side upload pre-check ───────────────────────────────────────────
console.log('\n5. Upload pre-check (checkUgcFile from the `uploads` spec)');
{
  const checkUgcFile = new Function(`return ${extractFn(ui, 'checkUgcFile')};`)();
  const uploads = svc.uploadLimits();
  const f = (name, size) => ({ name, size });
  const MB = 1024 * 1024;
  ok('video: .mp4 / .webm / .MOV ≤ 50 MB accepted', [f('a.mp4', 50 * MB), f('b.webm', 1), f('c.MOV', 10)].every((x) => checkUgcFile('video', x, uploads) === null));
  ok('video: > 50 MB → FILE_TOO_LARGE, .avi / no extension → INVALID_FILE_TYPE, 0 byte → EMPTY_FILE',
    checkUgcFile('video', f('a.mp4', 50 * MB + 1), uploads) === 'FILE_TOO_LARGE' && checkUgcFile('video', f('a.avi', 10), uploads) === 'INVALID_FILE_TYPE'
    && checkUgcFile('video', f('mp4', 10), uploads) === 'INVALID_FILE_TYPE' && checkUgcFile('video', f('a.mp4', 0), uploads) === 'EMPTY_FILE');
  ok('thumbnail: .jpg / .jpeg / .png / .webp ≤ 5 MB accepted; > 5 MB, .gif, a video refused',
    ['a.jpg', 'a.jpeg', 'a.png', 'a.webp'].every((n) => checkUgcFile('thumbnail', f(n, 5 * MB), uploads) === null)
    && checkUgcFile('thumbnail', f('a.png', 5 * MB + 1), uploads) === 'FILE_TOO_LARGE' && checkUgcFile('thumbnail', f('a.gif', 1), uploads) === 'INVALID_FILE_TYPE'
    && checkUgcFile('thumbnail', f('a.mp4', 1), uploads) === 'INVALID_FILE_TYPE');
  ok('same verdicts as the server pre-check (checkUgcUpload) on a sample', [['video', 'x.mp4', 3], ['video', 'x.avi', 3], ['video', 'x.webm', 60 * MB], ['thumbnail', 'x.webp', 0], ['thumbnail', 'x.png', 6 * MB], ['thumbnail', 'x.jpeg', 9]]
    .every(([k, n, s]) => (checkUgcFile(k, f(n, s), uploads) ?? 'OK') === (U.checkUgcUpload(k, { name: n, size: s }).code ?? 'OK')));
  ok('the picker accepts the spec MIME types + extensions; the fallback spec equals the server uploadLimits()',
    /accept=\{`\$\{spec\.accept\},\$\{spec\.extensions\.join\(","\)\}`\}/.test(ui)
    && /maxBytes: UGC_MEDIA\.video\.maxBytes, extensions: \[\.\.\.UGC_MEDIA\.video\.exts\], accept: "video\/mp4,video\/webm,video\/quicktime"/.test(ui)
    && uploads.video.accept === 'video/mp4,video/webm,video/quicktime' && uploads.thumbnail.accept === 'image/jpeg,image/png,image/webp');
  ok('a spinner is shown while uploading (dcApi has no progress callback)', /busy \? <Loader2 className="w-3\.5 h-3\.5 animate-spin" \/>/.test(ui) && /Téléversement…/.test(ui));
}

// ── 6. Reward select + form validation ────────────────────────────────────────
console.log('\n6. Reward 5 / 6 / 7 + form validation');
{
  ok('REWARD_CHOICES (lib) is exactly [5, 6, 7]', eq([...U.REWARD_CHOICES], [5, 6, 7]));
  const selects = [...all.matchAll(/<select\b[^\n]*\sdata-ugc-reward-select>([\s\S]*?)<\/select>/g)].map((m) => m[1]);
  ok('one reward <select>, its options come only from REWARD_CHOICES', selects.length === 1 && /^\s*\{REWARD_CHOICES\.map\(\(n\) => <option key=\{n\} value=\{String\(n\)\}>\{n\} DH par vente<\/option>\)\}\s*$/.test(selects[0]), selects);
  ok('no free-typed reward input', !/rewardPerSaleMad[^\n]*<input|<input[^>]*rewardPerSaleMad/.test(all));
  const src = editor;
  const toIntSrc = extractFn(read(`${DIR}/_components/ui.jsx`), 'toInt');
  const buildPayload = new Function('REWARD_CHOICES', 'UGC_LIMITS', `${toIntSrc}\nreturn ${extractFn(src, 'buildPayload')};`)(U.REWARD_CHOICES, U.UGC_LIMITS);
  const base = { title: 'Routine soin', memberId: 'm1', active: true, minDailySales: '3', maxDailySales: '15', rewardPerSaleMad: '6', sortOrder: '', videoUrl: null, thumbnailUrl: null };
  const r0 = buildPayload(base, true, 1000);
  ok('valid form → payload with integers, reward 6, no sortOrder at creation when empty', eq(r0.errors, {}) && r0.payload.minDailySales === 3 && r0.payload.maxDailySales === 15
    && r0.payload.rewardPerSaleMad === 6 && !('sortOrder' in r0.payload) && r0.payload.videoUrl === null && U.validateVideoSettings({ ...r0.payload, sortOrder: 0 }).ok);
  const cases = [
    [{ rewardPerSaleMad: '8' }, 'rewardPerSaleMad', 'INVALID_REWARD'], [{ rewardPerSaleMad: '4' }, 'rewardPerSaleMad', 'INVALID_REWARD'],
    [{ minDailySales: '9', maxDailySales: '2' }, 'maxDailySales', 'MAX_BELOW_MIN'], [{ minDailySales: '-1' }, 'minDailySales', 'INVALID_MIN_SALES'],
    [{ maxDailySales: '1001' }, 'maxDailySales', 'INVALID_MAX_SALES'], [{ minDailySales: '1.5' }, 'minDailySales', 'INVALID_MIN_SALES'],
    [{ title: '  ' }, 'title', 'INVALID_TITLE'], [{ title: 'x'.repeat(121) }, 'title', 'INVALID_TITLE'], [{ title: '<b>' }, 'title', 'INVALID_TITLE'],
    [{ memberId: '' }, 'memberId', 'MEMBER_REQUIRED'],
  ];
  const bad = cases.filter(([patch, k, code]) => {
    const local = buildPayload({ ...base, ...patch }, true, 1000).errors[k];
    const server = U.validateVideoSettings({ ...buildPayload({ ...base, ...patch }, true, 1000).payload, sortOrder: 0, memberId: patch.memberId ?? 'm1' }).errors[k];
    return local !== code || server !== code;
  });
  ok('client-side field codes = server codes (reward 4/8, max<min, ranges, title, owner)', bad.length === 0, bad);
  ok('edit: empty / negative sort order → INVALID_SORT_ORDER; 0 accepted', buildPayload({ ...base, sortOrder: '' }, false, 1000).errors.sortOrder === 'INVALID_SORT_ORDER'
    && buildPayload({ ...base, sortOrder: '-2' }, false, 1000).errors.sortOrder === 'INVALID_SORT_ORDER' && buildPayload({ ...base, sortOrder: '0' }, false, 1000).payload.sortOrder === 0);
  ok('server field errors are shown next to the fields (r.fields → errors)', /if \(!r\.ok\) \{ setErrors\(r\.fields \|\| \{\}\);/.test(editor)
    && ['title', 'memberId', 'minDailySales', 'maxDailySales', 'rewardPerSaleMad', 'sortOrder'].every((k) => new RegExp(`error=\\{errors\\.${k}\\}`).test(editor))
    && ['active', 'videoUrl', 'thumbnailUrl'].every((k) => new RegExp(`<UgcFieldError code=\\{errors\\.${k}\\} />`).test(editor)));
  ok('owner select: eligible members, each with the number of videos it already owns', /\{members\.map\(\(m\) => \(/.test(editor) && /owned\.get\(m\.id\) \|\| 0\} vidéo/.test(editor) && /Un même membre démo peut posséder plusieurs vidéos/.test(editor));
  ok('save / archive / restore buttons disabled while saving', /className=\{btnPrimary\} disabled=\{busy\} onClick=\{save\}/.test(editor) && /className=\{btnDanger\} disabled=\{busy\} onClick=\{archive\}/.test(editor)
    && /disabled=\{busy \|\| restoreBlockers\.length > 0\} onClick=\{restore\}/.test(editor) && /<fieldset disabled=\{archived \|\| busy\}/.test(editor));
}

// ── 7. Video previews ─────────────────────────────────────────────────────────
console.log('\n7. Video previews');
{
  const tags = [...all.matchAll(/<video\b[^>]*>/g)].map((m) => m[0]);
  ok(`every <video> has controls and no autoplay / loop / muted autostart (${tags.length})`, tags.length >= 1 && tags.every((t) => /\bcontrols\b/.test(t) && !/autoplay|autoPlay|\bloop\b/.test(t)), tags);
  ok('preview loads metadata only, inline', tags.every((t) => /preload="metadata"/.test(t) && /playsInline/.test(t)));
}

// ── 8. Error codes → French ───────────────────────────────────────────────────
console.log('\n8. Error codes → French');
{
  const CODE = extractObject(ui, 'UGC_CODE_TEXT'), FIELD = extractObject(ui, 'UGC_FIELD_TEXT');
  ok('UGC_CODE_TEXT / UGC_FIELD_TEXT parse', !!CODE && !!FIELD);
  const french = (code, s) => typeof s === 'string' && s.length > 8 && s !== code && / /.test(s) && !/\b(invalid|error|not found|too large)\b/i.test(s);
  const DOC_TOP = ['INVALID_JSON', 'INVALID_SETTINGS', 'MEMBER_NOT_FOUND', 'NOT_FOUND', 'ARCHIVED', 'VIDEO_LIMIT_REACHED', 'MEMBER_ARCHIVED', 'NO_MEMBERS', 'UGC_DISABLED', 'INVALID_INPUT', 'INVALID_FILE_TYPE', 'FILE_TOO_LARGE', 'EMPTY_FILE', 'SERVER_ERROR'];
  const DOC_FIELD = ['INVALID_TYPE', 'INVALID_TITLE', 'MEMBER_REQUIRED', 'MEMBER_ARCHIVED', 'INVALID_MIN_SALES', 'INVALID_MAX_SALES', 'MAX_BELOW_MIN', 'INVALID_REWARD', 'INVALID_ACTIVE', 'INVALID_SORT_ORDER', 'INVALID_MEDIA_URL', 'INVALID_TARGET_COUNT'];
  ok('every documented top-level code has a French label', DOC_TOP.every((c) => french(c, CODE?.[c])), DOC_TOP.filter((c) => !french(c, CODE?.[c])));
  ok('every documented field code has a French label', DOC_FIELD.every((c) => french(c, FIELD?.[c])), DOC_FIELD.filter((c) => !french(c, FIELD?.[c])));
  // Codes the backend can really emit (read from its source): nothing unlabelled.
  const svcSrc = read('src/lib/services/demoCompUgcService.js'), libSrc = read('src/lib/demoCompUgc.js');
  const top = new Set(['SERVER_ERROR', ...[...svcSrc.matchAll(/DemoCompError\('(\w+)'/g)].map((m) => m[1]), ...[...libSrc.matchAll(/code: '(\w+)', status/g)].map((m) => m[1]),
    ...[...(extractFn(libSrc, 'uploadErrorCode') || '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])]);
  const fld = new Set([...libSrc.matchAll(/errors\.\w+ = '(\w+)'/g), ...svcSrc.matchAll(/errors\[k\] = '(\w+)'/g), ...svcSrc.matchAll(/\{ memberId: '(\w+)' \}/g)].map((m) => m[1]));
  ok(`every top-level code thrown by the service / lib is labelled (${[...top].join(', ')})`, top.size >= 12 && [...top].every((c) => french(c, CODE?.[c])), [...top].filter((c) => !french(c, CODE?.[c])));
  ok(`every field code produced by the validation is labelled (${[...fld].join(', ')})`, fld.size >= 12 && [...fld].every((c) => french(c, FIELD?.[c])), [...fld].filter((c) => !french(c, FIELD?.[c])));
  ok('API errors go through ugcErrorText (UGC codes first, dcApi session / network messages kept)',
    /if \(r\.status === 401 \|\| r\.status === 403 \|\| r\.code === "NETWORK" \|\| !r\.code\) return r\.error;/.test(ui) && /return UGC_CODE_TEXT\[r\.code\] \|\| r\.error;/.test(ui)
    && !/text: r\.error/.test(page + editor));
  ok('field errors rendered from UGC_FIELD_TEXT', /const msg = code \? UGC_FIELD_TEXT\[code\] \|\| UGC_CODE_TEXT\[code\] \|\| code : null;/.test(ui));
}

// ── 9. Simulation marking, archive / restore, data attributes, layout ────────
console.log('\n9. SIMULATION / DÉMO, archive / restore, test hooks, mobile');
{
  ok('page + editor render the shared <SimulationNotice and the UGC note + SIMULATION · DÉMO badge',
    [page, editor].every((s) => /<SimulationNotice\b/.test(s) && /<UgcSimulationNote \/>/.test(s) && /<SimBadge \/>/.test(s)) && /SIMULATION · DÉMO/.test(ui) && /DÉMO :/.test(ui) && /simulées/.test(ui));
  ok('placeholder state shown: "Non visible — pas de fichier vidéo"', /Non visible — pas de fichier vidéo/.test(ui) && /non visible — pas de fichier vidéo/.test(ui) && /"Sans fichier vidéo"/.test(page));
  const confirms = [...all.matchAll(/window\.confirm\(`Retirer la vidéo démo[^`]*`\)/g)].map((m) => m[0]);
  ok('"Retirer" (archive) asks for confirmation in the list and the editor: nothing deleted, history kept, restorable, comes back disabled',
    confirms.length === 2 && confirms.every((c) => /Rien n'est supprimé/.test(c) && /historique de ventes simulées est conservé/.test(c) && /restaurer/.test(c) && /désactivée/.test(c)));
  ok('Restore button in the list and the editor (blocked at the limit / when the owner is archived)', /Restaurer\s*<\/button>/.test(page) && /Restaurer cette vidéo démo/.test(editor)
    && /const restoreBlock = \(v\) => \(full \?/.test(page) && /restoreBlockers/.test(editor));
  ok('retired video: read-only editor (fieldset disabled), retired filter explains history kept', /const archived = !!detail\?\.archivedAt;/.test(editor) && /\{!archived && \(\s*<div className="flex justify-end">/.test(editor)
    && /historique conservé/.test(page));
  ok('data attributes: data-ugc-admin-row={id}, data-ugc-admin-form, data-ugc-admin-toggle={id}, data-ugc-admin-module-switch',
    /data-ugc-admin-row=\{v\.id\}/.test(page) && /data-ugc-admin-form/.test(editor) && /data-ugc-admin-toggle=\{v\.id\}/.test(page) && /data-ugc-admin-module-switch/.test(page));
  ok('module card: switch, target input, save target, "Générer jusqu\'à N vidéos", "Exécuter maintenant" (disabled while OFF), last run + last error, counts',
    /Générer jusqu&apos;à \{shownTarget\} vidéos/.test(page) && /onClick=\{run\} disabled=\{!!busy \|\| !enabled\}/.test(page) && /settings\.lastRunAt/.test(page) && /settings\.lastError/.test(page)
    && /counts\.listed/.test(page) && /counts\.archived/.test(page) && /UGC_DEFAULTS\.targetVideoCount/.test(page) && U.UGC_DEFAULTS.targetVideoCount === 20);
  ok('list: filters (active / inactive / no file / retired), rank, owner avatar, min–max, reward DH, sales 24 h / 7 j / 30 j, rewards 30 j + total, last sale',
    /\["archived", "Retirées"/.test(page) && /\["active", "Actives"/.test(page) && /v\.rank \? `#\$\{v\.rank\}`/.test(page) && /<Avatar src=\{v\.owner\?\.avatarUrl\}/.test(page)
    && /\{v\.rewardPerSaleMad\} DH \/ vente/.test(page) && ['s.sales24h', 's.sales7d', 's.sales30d', 'fmtDh(s.reward30dCents)', 'fmtDh(s.rewardAllCents)', 'fmtDateTime(v.lastSaleAt)'].every((x) => page.includes(x)));
  ok('loading / error (retry) / empty states', /<Loader2 className="w-6 h-6 animate-spin text-gray-400" \/>/.test(page) && /Réessayer/.test(page) && /Aucune vidéo UGC démo\./.test(page) && /Aucune vidéo dans ce filtre\./.test(page));
  ok('editor detail: versions history + 30-day daily chart/table from GET /videos/{id}', /<Versions versions=\{detail\.versions\} \/>/.test(editor) && /<DailyHistory daily=\{detail\.history\?\.daily\} \/>/.test(editor));
  const minW = [...all.matchAll(/min-w-\[(\d+)px\]/g)].map((m) => +m[1]);
  ok('mobile: no fixed min-width above 360 px', minW.every((n) => n <= 360), minW);
  const plainCols = [...all.matchAll(/(?<![\w:-])grid-cols-(\d+)/g)].map((m) => +m[1]);
  ok('mobile: unprefixed grids have ≤ 3 columns (wider ones only from sm:)', plainCols.every((n) => n <= 3), plainCols);
  const tables = [...all.matchAll(/<table\b/g)].map((m) => all.slice(Math.max(0, m.index - 120), m.index));
  ok('mobile: every table sits in an overflow-x-auto box; the video list is cards, not a table', tables.every((pre) => /overflow-x-auto/.test(pre)) && !/<table/.test(page));
}

// ── 10. Contract: real admin handlers (fake DB) carry every key the UI reads ──
console.log('\n10. Contract (admin handlers on a fake DB)');
{
  const db = makeUgcFakeDb();
  const t = Date.parse('2026-11-09T11:00:00Z');
  const deps = { db, now: () => t };
  svc.__resetDemoCompUgcState();
  const m = db._seedMember({ name: 'Khadija' });
  db._seedMember({ name: 'Mehdi' });
  const h = svc.adminUgcHandlers(deps);
  const ADMIN = { id: 'admin-1', role: 'ADMIN' };
  const post = (fn, body, ctx = {}) => fn(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), ctx, ADMIN);
  const gen = await (await post(h.generate)).json();
  ok('generate → { created, target, events }; placeholders without videoUrl', gen.created === 20 && gen.target === 20 && typeof gen.events === 'number');
  const created = await post(h.createVideo, { title: 'Ma vidéo', memberId: m.id, rewardPerSaleMad: 7, videoUrl: '/uploads/demo-competition-ugc/v.mp4' });
  const cv = (await created.json()).video;
  ok('create → 201 { video } with versions + 30-day history (the editor opens it by video.id)', created.status === 201 && !!cv?.id && Array.isArray(cv.versions) && cv.history?.daily?.length === 30
    && ['day', 'sales', 'rewardCents'].every((k) => k in cv.history.daily[0]) && ['effectiveFrom', 'active', 'minDailySales', 'maxDailySales', 'rewardPerSaleMad', 'createdBy'].every((k) => k in cv.versions[0]));
  const st = await (await h.getState(new Request('http://x'), {}, ADMIN)).json();
  const need = (obj, keys) => keys.filter((k) => !(k in (obj || {})));
  const miss = [
    ...need(st, ['settings', 'limits', 'uploads', 'counts', 'members', 'videos']),
    ...need(st.settings, ['enabled', 'targetVideoCount', 'initializedAt', 'resumedAt', 'pausedAt', 'lastRunAt', 'lastRunEvents', 'lastError']).map((k) => `settings.${k}`),
    ...need(st.limits, ['maxVideos', 'salesMax', 'titleMax', 'targetMin', 'targetMax']).map((k) => `limits.${k}`),
    ...need(st.counts, ['videos', 'active', 'listed', 'archived']).map((k) => `counts.${k}`),
    ...need(st.members[0], ['id', 'name', 'avatarUrl', 'active']).map((k) => `members[].${k}`),
    ...need(st.videos[0], ['id', 'title', 'memberId', 'active', 'minDailySales', 'maxDailySales', 'rewardPerSaleMad', 'sortOrder', 'videoUrl', 'thumbnailUrl', 'createdAt', 'archivedAt', 'owner', 'rank', 'listed', 'lastSaleAt', 'stats']).map((k) => `videos[].${k}`),
    ...need(st.videos[0]?.owner, ['name', 'avatarUrl', 'archivedAt']).map((k) => `videos[].owner.${k}`),
    ...need(st.videos[0]?.stats, ['sales24h', 'sales7d', 'sales30d', 'salesAll', 'reward24hCents', 'reward7dCents', 'reward30dCents', 'rewardAllCents']).map((k) => `videos[].stats.${k}`),
    ...['video', 'thumbnail'].flatMap((k) => need(st.uploads?.[k], ['maxBytes', 'extensions', 'accept']).map((x) => `uploads.${k}.${x}`)),
  ];
  ok('GET state carries every key the page reads', miss.length === 0, miss);
  ok('placeholders: no videoUrl → rank null, not listed (UI shows "non visible — pas de fichier vidéo")', st.videos.filter((v) => !v.videoUrl).length === 20 && st.videos.filter((v) => !v.videoUrl).every((v) => v.rank === null && v.listed === false));
  ok('one member owns several videos (round-robin)', st.videos.filter((v) => v.memberId === m.id).length >= 2);
  const re = await (await post(h.generate)).json();
  ok('generate again → creates nothing', re.created === 0);
  const run = await post(h.run);
  ok('run while OFF → 409 UGC_DISABLED (labelled)', run.status === 409 && (await run.json()).code === 'UGC_DISABLED');
  await h.updateSettings(new Request('http://x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }), {}, ADMIN);
  const run2 = await (await post(h.run)).json();
  ok('run while ON → { events, videos, error }', ['events', 'videos', 'error'].every((k) => k in run2));
  const bad = await (await h.updateSettings(new Request('http://x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetVideoCount: 0 }) }), {}, ADMIN)).json();
  ok('PATCH target 0 → INVALID_SETTINGS fields.targetVideoCount = INVALID_TARGET_COUNT (shown under the target input)', bad.code === 'INVALID_SETTINGS' && bad.fields?.targetVideoCount === 'INVALID_TARGET_COUNT' && /setTargetError\(r\.fields\?\.targetVideoCount \|\| null\)/.test(page));
  const ar = await (await post(h.archiveVideo, null, { params: Promise.resolve({ id: cv.id }) })).json();
  const rs = await (await post(h.restoreVideo, null, { params: Promise.resolve({ id: cv.id }) })).json();
  ok('archive → { archived, archivedAt }; restore → { restored }', ar.archived === true && !!ar.archivedAt && rs.restored === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
