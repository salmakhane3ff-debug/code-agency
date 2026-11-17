/**
 * scripts/affiliateUploadHeaders.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate multipart uploads: a FormData request must NEVER carry a hand-set
 * Content-Type (the browser / fetch sets multipart/form-data WITH its boundary),
 * while every JSON request keeps "Content-Type: application/json".
 *
 *   1. page.jsx authHeaders(json = true): Bearer token always; JSON Content-Type by
 *      default; authHeaders(false) → no Content-Type key at all.
 *   2. Real fetch/undici behaviour: a Request built with authHeaders(false) + FormData
 *      parses as multipart (formData() works, boundary present); the old headers
 *      (application/json + FormData) cannot be parsed — the avatar bug.
 *   3. Static audit of EVERY affiliate upload (src/app/affiliate/**, src/components/
 *      affiliate/**): each fetch whose body is a FormData variable uses a header helper
 *      that — evaluated from the file itself — sets no Content-Type; XHR uploads never
 *      call setRequestHeader("Content-Type", …).
 *   4. Every JSON-body fetch keeps application/json (page.jsx, UgcTab, BrandTab).
 *   5. Recruiter + admin + shared components (src/app/recruiter/**, src/app/admin/**,
 *      src/components/**): every FormData upload — direct fetch or through a helper
 *      (dcApi, payment-proofs api, payout-banks call, whose source is executed with a
 *      recording fetch) — sends no Content-Type; their JSON requests keep application/json.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
};
const hasContentType = (h) => Object.keys(h || {}).some((k) => k.toLowerCase() === 'content-type');

/** Extract `function <name>(…) { … }` (balanced braces) or `const <name> = (…) => …;` from a source file. */
function extractHelper(src, name) {
  const fn = new RegExp(`function ${name}\\s*\\(`).exec(src);
  if (fn) {
    const open = src.indexOf('{', src.indexOf(')', fn.index));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(fn.index, i + 1);
    }
  }
  const arrow = new RegExp(`const ${name}\\s*=\\s*\\([^)]*\\)\\s*=>[^\\n]*;`).exec(src);
  return arrow ? arrow[0] : null;
}
/** Evaluate a helper (+ the helpers it calls) with a fake localStorage holding a token. */
function loadHelper(src, name, deps = []) {
  const code = [...deps, name].map((n) => extractHelper(src, n)).join('\n');
  const localStorage = { getItem: (k) => (k === 'affiliateToken' ? 'tok123' : null) };
  return new Function('localStorage', `${code}\nreturn ${name};`)(localStorage);
}

// ── 1. page.jsx authHeaders ──────────────────────────────────────────────────
console.log('\n1. Affiliate dashboard authHeaders(json = true)');
const PAGE = 'src/app/affiliate/dashboard/page.jsx';
const page = read(PAGE);
ok('authHeaders takes a json flag defaulting to true', /function authHeaders\(json = true\)/.test(page));
const authHeaders = loadHelper(page, 'authHeaders');
const j = authHeaders(), jt = authHeaders(true), m = authHeaders(false);
ok('default (JSON) → exactly Content-Type application/json + Bearer token',
  JSON.stringify(Object.keys(j).sort()) === JSON.stringify(['Authorization', 'Content-Type']) && j['Content-Type'] === 'application/json' && j.Authorization === 'Bearer tok123', j);
ok('authHeaders(true) is identical to the default', JSON.stringify(jt) === JSON.stringify(j));
ok('authHeaders(false) (FormData) → ONLY the Bearer token, no Content-Type at all',
  JSON.stringify(m) === JSON.stringify({ Authorization: 'Bearer tok123' }) && !hasContentType(m), m);
ok('never sets multipart/form-data by hand anywhere in the affiliate code (no such string literal)',
  ['src/app/affiliate/dashboard/page.jsx', 'src/app/affiliate/dashboard/UgcTab.jsx', 'src/app/affiliate/dashboard/BrandTab.jsx', 'src/app/affiliate/dashboard/DepositTab.jsx']
    .every((f) => !/["'`]multipart\/form-data/i.test(read(f))));

// ── 2. Real multipart behaviour (Node's fetch / undici Request) ─────────────
console.log('\n2. Multipart request behaviour');
{
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });
  const form = new FormData();
  form.append('file', png, 'avatar.png');
  const good = new Request('http://local.test/api/affiliate/avatar', { method: 'POST', headers: authHeaders(false), body: form });
  const ct = good.headers.get('content-type') || '';
  ok('authHeaders(false) + FormData → Content-Type is multipart/form-data WITH a boundary (set by fetch)', /^multipart\/form-data; boundary=\S+/.test(ct), ct);
  ok('… and the Authorization header is still sent', good.headers.get('authorization') === 'Bearer tok123');
  const parsed = await good.formData();
  const f = parsed.get('file');
  ok('… and the server side can parse it (req.formData() → the file, name and size intact)', f && typeof f.arrayBuffer === 'function' && f.name === 'avatar.png' && f.size === 8);

  const form2 = new FormData();
  form2.append('file', png, 'avatar.png');
  const bad = new Request('http://local.test/api/affiliate/avatar', { method: 'POST', headers: authHeaders(), body: form2 });
  let threw = false;
  try { await bad.formData(); } catch { threw = true; }
  ok('regression: the OLD headers (application/json on a FormData body) cannot be parsed as multipart (the avatar bug)',
    bad.headers.get('content-type') === 'application/json' && threw);
}

// ── 3. Every affiliate upload ────────────────────────────────────────────────
console.log('\n3. Audit of every affiliate FormData upload');
const walk = (dir) => readdirSync(join(ROOT, dir)).flatMap((n) => {
  const p = join(dir, n);
  return statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.(jsx?|mjs)$/.test(n) ? [p] : [];
});
const files = ['src/app/affiliate', 'src/components/affiliate'].flatMap(walk);
const uploads = [];
const xhrUploads = [];
for (const file of files) {
  const src = read(file);
  const fdVars = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*new FormData\(/g)].map((x) => x[1]);
  if (!fdVars.length) continue;
  // fetch(…, { … body: <formDataVar> … }) — headers expression of that same options object
  for (const call of src.matchAll(/fetch\(([\s\S]{0,400}?)\}\s*\)/g)) {
    const body = /body:\s*(\w+)\b(?!\s*[.(])/.exec(call[1]);
    if (!body || !fdVars.includes(body[1])) continue;
    const headers = /headers:\s*([^,\n}]+(?:\([^)]*\))?)/.exec(call[1]);
    uploads.push({ file, line: src.slice(0, call.index).split('\n').length, headersExpr: headers ? headers[1].trim() : null, src });
  }
  if (/new XMLHttpRequest\(\)/.test(src) && fdVars.length) xhrUploads.push({ file, src });
}
const rel = (u) => `${relative(ROOT, join(ROOT, u.file))}:${u.line}`;
ok(`found the affiliate fetch uploads (avatar, UGC new + replace, brand payment proof): ${uploads.length}`, uploads.length >= 4, uploads.map(rel));
for (const u of uploads) {
  let headers;
  if (u.headersExpr === null) headers = {};
  else {
    const call = /^(\w+)\((.*)\)$/.exec(u.headersExpr);
    if (!call) { ok(`${rel(u)}: headers come from a helper call`, false, u.headersExpr); continue; }
    const deps = call[1] === 'jsonHeaders' ? ['authHeaders'] : [];
    const helper = loadHelper(u.src, call[1], deps);
    const args = call[2].trim() ? new Function(`return [${call[2]}];`)() : [];
    headers = helper(...args);
  }
  ok(`${rel(u)}: FormData upload sends the Bearer token and NO Content-Type (${u.headersExpr ?? 'no headers'})`,
    !hasContentType(headers) && /^Bearer /.test(headers.Authorization || ''), headers);
}
ok('the avatar upload (POST /api/affiliate/avatar) is one of them and uses authHeaders(false)',
  /fetch\("\/api\/affiliate\/avatar",\s*\{\s*method:\s*"POST",\s*headers:\s*authHeaders\(false\)/.test(page));
ok(`XHR uploads (identity / CIN, deposit proof): ${xhrUploads.length}, none sets Content-Type, each sends the Bearer token`,
  xhrUploads.length >= 2 && xhrUploads.every((x) => !/setRequestHeader\(\s*["']content-type/i.test(x.src) && /setRequestHeader\("Authorization", `Bearer \$\{token\}`\)/.test(x.src)),
  xhrUploads.map((x) => x.file));

// ── 4. JSON requests keep application/json ──────────────────────────────────
console.log('\n4. JSON requests keep Content-Type: application/json');
{
  const jsonCalls = [...page.matchAll(/headers:\s*(authHeaders\([^)]*\))\s*,\s*\n?\s*body:\s*JSON\.stringify/g)].map((x) => x[1]);
  ok(`page.jsx: every JSON-body fetch uses authHeaders() with the JSON default (${jsonCalls.length} calls)`,
    jsonCalls.length >= 5 && jsonCalls.every((c) => c === 'authHeaders()'), jsonCalls);
  ok('page.jsx: authHeaders(false) is used ONLY for the FormData avatar upload', (page.match(/headers:\s*authHeaders\(false\)/g) || []).length === 1);
  const ugc = read('src/app/affiliate/dashboard/UgcTab.jsx');
  const ugcJson = loadHelper(ugc, 'jsonHeaders', ['authHeaders'])();
  ok('UgcTab: jsonHeaders() → application/json + Bearer', ugcJson['Content-Type'] === 'application/json' && /^Bearer /.test(ugcJson.Authorization));
  ok('UgcTab: every JSON.stringify body uses jsonHeaders()',
    [...ugc.matchAll(/headers:\s*(\w+)\(\)[^\n]*body:\s*JSON\.stringify/g)].every((x) => x[1] === 'jsonHeaders'));
  const brand = read('src/app/affiliate/dashboard/BrandTab.jsx');
  const brandAuth = loadHelper(brand, 'authHeaders');
  ok('BrandTab: authHeaders(true) → application/json; authHeaders() (FormData default) → none',
    brandAuth(true)['Content-Type'] === 'application/json' && !hasContentType(brandAuth()));
  ok('BrandTab: every JSON.stringify body uses authHeaders(true)',
    [...brand.matchAll(/headers:\s*(authHeaders\([^)]*\))[^\n]*body:\s*JSON\.stringify/g)].every((x) => x[1] === 'authHeaders(true)'));
}

// ── 5. Recruiter + admin FormData uploads ───────────────────────────────────
// Same rule outside the affiliate area: a FormData body never carries a hand-set
// Content-Type. Direct fetch() calls are checked on their options object; uploads made
// through a shared helper (dcApi, payment-proofs api, payout-banks call) are checked by
// EXECUTING the helper's source with a recording fetch: FormData → no Content-Type,
// JSON body → application/json.
console.log('\n5. Audit of every recruiter / admin FormData upload');
{
  const otherFiles = ['src/app/recruiter', 'src/app/admin', 'src/components'].flatMap(walk)
    .filter((f) => !f.startsWith(join('src', 'components', 'affiliate')));
  const sites = [];
  for (const file of otherFiles) {
    const src = read(file);
    const fdVars = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*new FormData\(/g)].map((x) => x[1]);
    if (!fdVars.length) continue;
    for (const c of src.matchAll(/\b(\w+)\(\s*([^,()]+(?:\([^)]*\))?[^,()]*),\s*\{([^{}]*)\}\s*\)/g)) {
      const opts = c[3];
      const named = /\b(?:body|form):\s*(\w+)\b(?!\s*[.(])/.exec(opts);
      const short = /(?:^|,)\s*(body|form)\s*(?=,|$)/.exec(opts.trim());
      const v = named ? named[1] : short ? short[1] : null;
      if (!v || !fdVars.includes(v)) continue;
      sites.push({ file, line: src.slice(0, c.index).split('\n').length, fn: c[1], opts, src });
    }
  }
  const where = (x) => `${x.file}:${x.line}`;
  ok(`found the recruiter / admin FormData uploads (recruiter CIN, demo avatars, product / landing / reel / spin / watermark / selector images + videos, payout-bank logos, payment proofs): ${sites.length}`,
    sites.length >= 18 && sites.some((x) => x.file.includes(join('src', 'app', 'recruiter'))), sites.map(where));
  const direct = sites.filter((x) => x.fn === 'fetch');
  for (const x of direct) {
    ok(`${where(x)}: fetch(FormData) sets no headers / no Content-Type`, !/headers\s*:/.test(x.opts) && !/content-type/i.test(x.opts), x.opts.trim());
  }
  const recruiterSite = direct.find((x) => x.file.includes(join('src', 'app', 'recruiter', 'verification')));
  ok('recruiter identity (CIN front + back) upload: cookie session (credentials include), no Content-Type',
    !!recruiterSite && /credentials:\s*"include"/.test(recruiterSite.opts) && !/headers/.test(recruiterSite.opts));

  // helpers: run their real source with a recording fetch
  const HELPERS = {
    dcApi:  { file: 'src/app/admin/demo-competition/_components/ui.jsx', env: { API_BASE: '/api/admin/demo-competition', STATUS_TEXT: {}, CODE_TEXT: {}, normalizeFields: () => ({}) } },
    api:    { file: 'src/app/admin/payment-proofs/ui.jsx', env: {} },
    call:   { file: 'src/app/admin/payout-banks/page.jsx', env: {} },
  };
  const helperSites = sites.filter((x) => x.fn !== 'fetch');
  ok(`helper-based uploads use only known helpers (${[...new Set(helperSites.map((x) => x.fn))].join(', ')})`,
    helperSites.length >= 3 && helperSites.every((x) => HELPERS[x.fn]), helperSites.map((x) => `${where(x)} ${x.fn}`));
  for (const [name, { file, env }] of Object.entries(HELPERS)) {
    const src = read(file).replace(/\bexport\s+/g, '');
    const code = extractHelper(src, name);
    if (!code) { ok(`${file}: helper ${name} found`, false); continue; }
    const seen = [];
    const fakeFetch = async (url, init = {}) => { seen.push({ url, init }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
    const names = Object.keys(env);
    const helper = new Function('fetch', ...names, `return async ${code.replace(/^async\s+/, '')};`)(fakeFetch, ...names.map((k) => env[k]));
    const fd = new FormData(); fd.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'x.png');
    if (name === 'call') {
      await helper('/api/admin/payout-banks/b1/logo', { method: 'POST', body: fd });
      await helper('/api/admin/payout-banks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } else {
      await helper('/x', { method: 'POST', form: fd });
      await helper('/x', { method: 'POST', body: { a: 1 } });
    }
    const [up, js] = seen;
    const upHeaders = new Headers(up?.init?.headers || {});
    ok(`${file} ${name}(FormData): body is the FormData itself, NO Content-Type sent`, up?.init?.body === fd && !upHeaders.has('content-type'), up?.init?.headers);
    const req = new Request('http://local.test/u', { method: 'POST', headers: up?.init?.headers, body: up?.init?.body });
    ok(`${file} ${name}(FormData): fetch derives multipart/form-data WITH a boundary`, /^multipart\/form-data; boundary=/.test(req.headers.get('content-type') || ''));
    ok(`${file} ${name}(JSON): Content-Type application/json kept`, new Headers(js?.init?.headers || {}).get('content-type') === 'application/json');
  }

  ok('no recruiter / admin / shared client code sets "multipart/form-data" by hand',
    otherFiles.every((f) => !/["'`]multipart\/form-data/i.test(read(f))), otherFiles.filter((f) => /["'`]multipart\/form-data/i.test(read(f))));
  ok('no recruiter / admin / shared client upload uses XMLHttpRequest with a Content-Type header',
    otherFiles.every((f) => !/setRequestHeader\(\s*["']content-type/i.test(read(f))));

  // every recruiter / admin JSON-body fetch keeps application/json
  const jsonMissing = [];
  let jsonCount = 0;
  for (const f of otherFiles) {
    const src = read(f);
    for (const c of src.matchAll(/\bfetch\(([^;]*?)\{([^{}]*?(?:\{[^{}]*\}[^{}]*?)*)\}\s*\)/g)) {
      if (!/body:\s*JSON\.stringify/.test(c[2])) continue;
      jsonCount++;
      if (!/["']Content-Type["']:\s*["']application\/json["']/i.test(c[2])) jsonMissing.push(`${f}:${src.slice(0, c.index).split('\n').length}`);
    }
  }
  ok(`recruiter / admin: every fetch with a JSON.stringify body sends Content-Type application/json (${jsonCount} calls)`, jsonCount >= 50 && jsonMissing.length === 0, jsonMissing);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
