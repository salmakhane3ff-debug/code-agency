/**
 * scripts/r2Storage.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * R2 storage CONFIGURATION / UNIT tests with mocks — NOT a real R2 integration upload.
 * No network, no credentials: every env is a fake object (dummy values), the AWS SDK
 * (@aws-sdk/client-s3) is replaced by a recording fake module through a resolve hook,
 * and saveMedia()'s local fallback writes into a throw-away temp directory.
 *
 *   1. storageMode(): MEDIA_STORAGE=r2 recognised (case / whitespace); anything else local.
 *   2. isR2Configured(): true only with ALL six vars (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *      R2_BUCKET, R2_ENDPOINT, R2_PUBLIC_URL, R2_PREFIX); blank / whitespace = missing.
 *   3. saveMedia() with MEDIA_STORAGE=r2 but incomplete config → LOCAL fallback (never
 *      Cloudinary), logs the missing variable NAMES only.
 *   4. Keys `<R2_PREFIX>/<category>/<name>`, public URL = R2_PUBLIC_URL + "/" + key (no
 *      double slashes), image vs video categories (categoryFor).
 *   5. Real r2Deps() path on the fake SDK: S3Client gets endpoint + credentials, PutObject
 *      gets Bucket / Key / ContentType / CacheControl.
 *   6. Upload failure: logged with bucket / key / category / status / code / request id,
 *      WITHOUT the access key, the secret or signing fields; the thrown error is clean.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { register } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

// fake @aws-sdk/client-s3 (records every client + command on globalThis.__fakeS3)
const FAKE_SDK = `
  const st = globalThis.__fakeS3 ||= { clients: [], sent: [], fail: null };
  export class S3Client { constructor(cfg) { this.cfg = cfg; st.clients.push(cfg); }
    async send(cmd) { st.sent.push(cmd); if (st.fail) throw st.fail(); return { ETag: '"etag"' }; } }
  export class PutObjectCommand { constructor(input) { this.kind = 'put'; this.input = input; } }
  export class DeleteObjectCommand { constructor(input) { this.kind = 'delete'; this.input = input; } }
`;
register(`data:text/javascript,${encodeURIComponent(`
  const FAKE = "data:text/javascript," + encodeURIComponent(${JSON.stringify(FAKE_SDK)});
  export async function resolve(spec, ctx, next) {
    if (spec === "@aws-sdk/client-s3") return { url: FAKE, shortCircuit: true };
    return next(spec, ctx);
  }`)}`);

const R2 = await import('../src/lib/r2.js');
const { saveMedia, storageMode } = await import('../src/lib/cloudinary.js');
globalThis.__fakeS3 ||= { clients: [], sent: [], fail: null };
const S3 = globalThis.__fakeS3;

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };

// Dummy, obviously-fake values (never real credentials).
const AK = 'FAKEACCESSKEYID0001';
const SK = 'fake-secret-access-key-not-real-0001';
const ENV = {
  R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: SK, R2_BUCKET: 'test-bucket',
  R2_ENDPOINT: 'https://fake-account.r2.example.invalid', R2_PUBLIC_URL: 'https://media.example.invalid/', R2_PREFIX: '/site-a/',
};
const REQUIRED = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_PUBLIC_URL', 'R2_PREFIX'];

// console capture
const logs = [];
const orig = { error: console.error, warn: console.warn };
const capture = () => { for (const m of ['error', 'warn']) console[m] = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 5 }))).join(' ')); };
const release = () => { console.error = orig.error; console.warn = orig.warn; };

// process.env sandbox
const ENV_KEYS = ['MEDIA_STORAGE', ...REQUIRED, 'CLOUDINARY_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (vars) => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, vars); };
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

// ── 1. storageMode ───────────────────────────────────────────────────────────
console.log('\n1. MEDIA_STORAGE recognition');
{
  const mode = (v) => { setEnv(v === undefined ? {} : { MEDIA_STORAGE: v }); return storageMode(); };
  ok('"r2" → r2', mode('r2') === 'r2');
  ok('"R2" (upper case) → r2', mode('R2') === 'r2');
  ok('"  r2 \\n" (whitespace) → r2', mode('  r2 \n') === 'r2');
  ok('"cloudinary" → cloudinary', mode('cloudinary') === 'cloudinary');
  ok('unset / "" / "local" / "r2x" / "s3" → local', [undefined, '', 'local', 'r2x', 's3'].every((v) => mode(v) === 'local'));
  restoreEnv();
}

// ── 2. isR2Configured ────────────────────────────────────────────────────────
console.log('\n2. isR2Configured / r2ConfigStatus');
{
  ok('complete fake env → configured', R2.isR2Configured(ENV) && R2.r2ConfigStatus(ENV).missing.length === 0);
  ok('required variables are exactly the six R2_* names', REQUIRED.every((k) => !R2.isR2Configured({ ...ENV, [k]: undefined })));
  for (const k of REQUIRED) {
    const st = R2.r2ConfigStatus({ ...ENV, [k]: '   ' });
    ok(`${k} blank/whitespace → not configured, reported missing by NAME`, !st.ok && st.missing.length === 1 && st.missing[0] === k);
  }
  ok('R2_ACCOUNT_ID is not required', R2.isR2Configured({ ...ENV, R2_ACCOUNT_ID: undefined }));
  const st = R2.r2ConfigStatus({ R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: SK });
  ok('status never contains values', !JSON.stringify(st).includes(AK) && !JSON.stringify(st).includes(SK));
  let msg = '';
  try { R2.r2Config({ R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: SK }); } catch (e) { msg = e.message; }
  ok('r2Config(incomplete) throws with names only', /R2 config incomplete: missing R2_BUCKET, R2_ENDPOINT, R2_PUBLIC_URL, R2_PREFIX/.test(msg) && !msg.includes(AK) && !msg.includes(SK), msg);
}

// ── 3. saveMedia fallback (incomplete config) ────────────────────────────────
console.log('\n3. saveMedia: MEDIA_STORAGE=r2 with incomplete config → local fallback');
{
  const dir = mkdtempSync(join(tmpdir(), 'r2storage-test-'));
  const cwd = process.cwd();
  process.chdir(dir);
  setEnv({ MEDIA_STORAGE: 'r2', R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: SK, R2_BUCKET: 'test-bucket', CLOUDINARY_URL: 'cloudinary://fake:fake@fake' });
  const before = S3.sent.length;
  logs.length = 0; capture();
  let res;
  try { res = await saveMedia(Buffer.from('img'), { filename: 'p.png', folder: 'shopgold/uploads', subdir: 'x' }); } finally { release(); process.chdir(cwd); restoreEnv(); }
  ok('falls back to LOCAL storage (never Cloudinary, no R2 call)', res?.storage === 'local' && res.url === '/uploads/x/p.png' && S3.sent.length === before);
  ok('the file is written under <cwd>/public/uploads (temp dir here)', existsSync(join(dir, 'public', 'uploads', 'x', 'p.png')) && readFileSync(join(dir, 'public', 'uploads', 'x', 'p.png'), 'utf8') === 'img');
  const line = logs.join('\n');
  ok('the fallback is logged with the missing variable NAMES', /\[storage\] MEDIA_STORAGE=r2 but R2 configuration is incomplete \(missing: R2_ENDPOINT, R2_PUBLIC_URL, R2_PREFIX\)/.test(line), line);
  ok('… and without any value', !line.includes(AK) && !line.includes(SK) && !line.includes('test-bucket'));
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. Keys + public URLs + categories ───────────────────────────────────────
console.log('\n4. Object keys, public URLs, categories');
{
  const cfg = R2.r2Config(ENV);
  ok('prefix + public URL normalized (slashes trimmed)', cfg.prefix === 'site-a' && cfg.publicUrl === 'https://media.example.invalid');
  const key = R2.buildObjectKey({ prefix: cfg.prefix, category: 'products', filename: 'Photo 1.JPG', deterministic: true });
  ok('key = <prefix>/<category>/<name> (sanitized)', key === 'site-a/products/Photo-1.JPG', key);
  const rnd = R2.buildObjectKey({ prefix: cfg.prefix, category: 'avatars', filename: 'a.png', suffix: 'abcd1234' });
  ok('non-deterministic key gets a suffix before the extension', rnd === 'site-a/avatars/a-abcd1234.png', rnd);
  const url = R2.publicUrlForKey('https://media.example.invalid//', 'site-a/products/x.png');
  ok('public URL = R2_PUBLIC_URL + "/" + key, no double slashes', url === 'https://media.example.invalid/site-a/products/x.png' && !/[^:]\/\//.test(url), url);
  ok('traversal in the filename cannot escape the category', R2.buildObjectKey({ prefix: 'site-a', category: 'products', filename: '../../etc/passwd', deterministic: true }) === 'site-a/products/passwd');
  ok('categoryFor: video → videos (any folder)', R2.categoryFor('shopgold/avatars', 'video') === 'videos' && R2.categoryFor(undefined, 'video') === 'videos');
  ok('categoryFor: avatars / receipts folders, else products', R2.categoryFor('shopgold/avatars', 'image') === 'avatars' && R2.categoryFor('shopgold/receipts', 'image') === 'receipts' && R2.categoryFor('shopgold/uploads', 'image') === 'products');
  ok('detectResourceType: .mp4/.webm/.mov video, .png image', ['a.mp4', 'b.webm', 'c.MOV'].every((f) => R2.detectResourceType(f) === 'video') && R2.detectResourceType('d.png') === 'image');

  const calls = [];
  const deps = { putObject: async (p) => { calls.push(p); } };
  const img = await R2.saveMediaR2(Buffer.from('12345'), { filename: 'pic.webp', category: 'products', deterministic: true }, deps, ENV);
  ok('saveMediaR2 image: key, URL, content type, cache control', calls[0].key === 'site-a/products/pic.webp' && img.url === 'https://media.example.invalid/site-a/products/pic.webp'
    && calls[0].contentType === 'image/webp' && calls[0].cacheControl === R2.R2_CACHE_CONTROL && calls[0].bucket === 'test-bucket');
  const vid = await R2.saveMediaR2(Buffer.from('v'), { filename: 'clip.mp4', deterministic: true }, deps, ENV);
  ok('saveMediaR2 video (no category given): videos/ + video/mp4 + resource_type video', calls[1].key === 'site-a/videos/clip.mp4' && calls[1].contentType === 'video/mp4' && vid.resource_type === 'video');
  ok('the upload result carries no credential', !JSON.stringify([img, vid]).includes(AK) && !JSON.stringify([img, vid]).includes(SK));
}

// ── 5. The real r2Deps() path on the fake SDK ────────────────────────────────
console.log('\n5. r2Deps() → (fake) @aws-sdk/client-s3');
{
  S3.fail = null;
  const res = await R2.saveMediaR2(Buffer.from('abc'), { filename: 'logo.png', category: 'products', deterministic: true }, undefined, ENV);
  const client = S3.clients[S3.clients.length - 1];
  const cmd = S3.sent[S3.sent.length - 1];
  ok('S3Client: region auto, endpoint + credentials from env', client?.region === 'auto' && client.endpoint === ENV.R2_ENDPOINT
    && client.credentials?.accessKeyId === AK && client.credentials?.secretAccessKey === SK);
  ok('PutObjectCommand: Bucket / Key / ContentType / CacheControl / Body', cmd?.kind === 'put' && cmd.input.Bucket === 'test-bucket'
    && cmd.input.Key === 'site-a/products/logo.png' && cmd.input.ContentType === 'image/png' && cmd.input.CacheControl === R2.R2_CACHE_CONTROL && String(cmd.input.Body) === 'abc');
  ok('result URL', res.url === 'https://media.example.invalid/site-a/products/logo.png');
}

// ── 6. Upload failure diagnostics ────────────────────────────────────────────
console.log('\n6. Upload failure: useful diagnostics, no secrets');
{
  // An S3-style SignatureDoesNotMatch error as the SDK builds it: parsed XML fields become
  // enumerable properties (AWSAccessKeyId, StringToSign, SignatureProvided…) + $response.
  const sdkError = () => Object.assign(new Error(`The request signature we calculated does not match the signature you provided (key ${AK}).`), {
    name: 'SignatureDoesNotMatch', Code: 'SignatureDoesNotMatch', $fault: 'client',
    $metadata: { httpStatusCode: 403, requestId: 'req-123', attempts: 1 },
    AWSAccessKeyId: AK, StringToSign: 'AWS4-HMAC-SHA256\n20261117T000000Z\nSIGNED-SCOPE', SignatureProvided: 'deadbeefsignature',
    CanonicalRequest: `PUT\n/site-a/products/x.png\nX-Amz-Credential=${AK}`,
    $response: { statusCode: 403, headers: { 'x-amz-request-id': 'req-123' }, body: '<Error>…</Error>' },
  });
  S3.fail = sdkError;
  logs.length = 0; capture();
  let thrown;
  try { await R2.saveMediaR2(Buffer.from('abcd'), { filename: 'x.png', category: 'products', deterministic: true }, undefined, ENV); } catch (e) { thrown = e; } finally { release(); }
  S3.fail = null;
  const line = logs.join('\n');
  ok('the failure is thrown to the caller (upload not reported as success)', thrown instanceof Error);
  ok('logged once with bucket / key / category / status / code / request id',
    logs.length === 1 && line.includes('[r2] upload failed') && line.includes('test-bucket') && line.includes('site-a/products/x.png')
    && /category: 'products'/.test(line) && /status: 403/.test(line) && line.includes('SignatureDoesNotMatch') && line.includes('req-123'), line);
  const leaks = (s) => [AK, SK, 'deadbeefsignature', 'SIGNED-SCOPE', 'X-Amz-Credential', 'StringToSign', 'CanonicalRequest', ENV.R2_ENDPOINT].filter((x) => s.includes(x));
  ok('the log contains no access key, secret, signature, string-to-sign, canonical request or endpoint', leaks(line).length === 0, leaks(line));
  const printed = inspect(thrown, { depth: 5, showHidden: true });
  ok('the thrown error is clean: R2UploadError, generic code R2_UPLOAD_FAILED (no `status` — route mappers answer 500), provider code / HTTP status kept as r2Code / httpStatus, key; no SDK fields / cause / $response',
    thrown?.name === 'R2UploadError' && thrown.code === 'R2_UPLOAD_FAILED' && thrown.status === undefined && thrown.r2Code === 'SignatureDoesNotMatch' && thrown.httpStatus === 403 && thrown.key === 'site-a/products/x.png'
    && thrown.cause === undefined && thrown.$response === undefined && thrown.$metadata === undefined, printed);
  ok('console.error(thrownError) by a route (e.g. /api/image) would print no secret either', leaks(printed).length === 0, leaks(printed));
  ok('the access key inside the SDK message is redacted', /\[redacted\]/.test(thrown?.message || ''), thrown?.message);

  // network-level error (no HTTP status)
  S3.fail = () => Object.assign(new Error('getaddrinfo ENOTFOUND fake-account.r2.example.invalid'), { code: 'ENOTFOUND' });
  logs.length = 0; capture();
  let t2;
  try { await R2.saveMediaR2(Buffer.from('a'), { filename: 'v.mp4', deterministic: true }, undefined, ENV); } catch (e) { t2 = e; } finally { release(); }
  S3.fail = null;
  ok('network error: logged with code ENOTFOUND + videos key, status absent, thrown cleanly', t2?.code === 'R2_UPLOAD_FAILED' && t2.r2Code === 'ENOTFOUND' && t2.status === undefined && t2.httpStatus === undefined
    && /code: 'ENOTFOUND'/.test(logs.join('')) && logs.join('').includes('site-a/videos/v.mp4'));

  // delete failure: structured, scrubbed
  const del = await R2.destroyByUrlR2('https://media.example.invalid/site-a/products/x.png', { deleteObject: async () => { throw sdkError(); } }, ENV);
  ok('delete failure: structured result (code / status), message scrubbed, does not throw',
    del.ok === false && del.code === 'SignatureDoesNotMatch' && del.status === 403 && !JSON.stringify(del).includes(AK) && !JSON.stringify(del).includes(SK));

  ok('r2ErrorInfo of a plain string / null is safe', R2.r2ErrorInfo('boom').message === 'boom' && R2.r2ErrorInfo(null).code === 'Error');
}

console.log('\nNOTE: configuration / unit tests with a mocked SDK — NOT a real R2 integration upload.');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
