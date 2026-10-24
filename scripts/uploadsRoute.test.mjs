#!/usr/bin/env node
/**
 * scripts/uploadsRoute.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * /uploads/[...path] — local file serving (Phase 3C-12: Mini Chat voice notes).
 * Drives the REAL route handler against temporary files under the OS temp
 * directory (the route resolves public/uploads from process.cwd()). No server,
 * no network, no database. Proves:
 *   • .m4a is served as audio/mp4, full file without Range
 *   • .m4a byte ranges → 206 with correct Content-Range / Content-Length /
 *     Accept-Ranges and the exact bytes; unsatisfiable ranges → 416
 *   • .m4a range handling is identical to the existing video branch
 *   • images, videos and unknown extensions keep their existing behaviour
 *     (ranges do not spread to other types); path traversal stays blocked
 *   • temporary files are removed even when a check fails
 * Run: node scripts/uploadsRoute.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { register } from "node:module";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };

// The route imports "next/server"; plain Node ESM needs the explicit file (same
// resolve-hook approach as affiliateOrderOwnership.test.mjs).
register(`data:text/javascript,${encodeURIComponent(
  "export async function resolve(s, c, n) { return n(s === 'next/server' ? 'next/server.js' : s, c); }",
)}`);
const ROUTE = new URL("../src/app/uploads/[...path]/route.js", import.meta.url);

// ── Temporary tree (always removed: finally + exit fallback) ──────────────────
const TMP = realpathSync(tmpdir());
const root = mkdtempSync(join(TMP, "uploads-route-test-"));
const originalCwd = process.cwd();
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  if (root.startsWith(TMP + sep) && root.includes("uploads-route-test-")) rmSync(root, { recursive: true, force: true });
};
process.on("exit", cleanup);

const SIZE = 5000;
const bytes = (seed) => Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7 + seed) % 256));
const VOICE = "demo/chat/audio/3f2c9a1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b.m4a";
const files = { [VOICE]: bytes(1), "video.mp4": bytes(2), "img.jpg": bytes(3), "img.webp": bytes(4), "file.xyz": bytes(5) };

try {
  for (const [rel, buf] of Object.entries(files)) {
    const full = join(root, "public", "uploads", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, buf);
  }
  writeFileSync(join(root, "secret.m4a"), bytes(9)); // outside public/uploads — must never be served
  process.chdir(root);
  const { GET } = await import(ROUTE.href);

  const call = async (rel, range) => {
    const r = await GET(new Request(`http://local/uploads/${rel}`, { headers: range ? { range } : {} }), { params: Promise.resolve({ path: rel.split("/") }) });
    const body = Buffer.from(await r.arrayBuffer());
    const h = (k) => r.headers.get(k);
    return { status: r.status, body, type: h("content-type"), range: h("content-range"), length: h("content-length"), accept: h("accept-ranges"), cache: h("cache-control") };
  };
  const CACHE = "public, max-age=31536000, immutable";

  // ── 1. .m4a full file ───────────────────────────────────────────────────────
  console.log("\n1. .m4a without Range");
  {
    const r = await call(VOICE);
    ok("200, Content-Type audio/mp4", r.status === 200 && r.type === "audio/mp4", `${r.status} ${r.type}`);
    ok("full body, Content-Length = file size", r.body.equals(files[VOICE]) && r.length === String(SIZE));
    ok("Accept-Ranges: bytes + unchanged immutable caching", r.accept === "bytes" && r.cache === CACHE);
  }

  // ── 2. .m4a byte ranges ─────────────────────────────────────────────────────
  console.log("\n2. .m4a byte ranges");
  {
    const a = await call(VOICE, "bytes=0-1");
    ok("bytes=0-1 (Safari's probe) → 206", a.status === 206, `${a.status}`);
    ok("…Content-Range bytes 0-1/5000, Content-Length 2, audio/mp4", a.range === `bytes 0-1/${SIZE}` && a.length === "2" && a.type === "audio/mp4");
    ok("…body is exactly bytes 0–1, Accept-Ranges + caching kept", a.body.equals(files[VOICE].subarray(0, 2)) && a.accept === "bytes" && a.cache === CACHE);
    const b = await call(VOICE, "bytes=1000-");
    ok("open-ended bytes=1000- → 206 1000-4999/5000 with the exact slice", b.status === 206 && b.range === `bytes 1000-${SIZE - 1}/${SIZE}` && b.length === String(SIZE - 1000) && b.body.equals(files[VOICE].subarray(1000)));
    const c = await call(VOICE, "bytes=1234-2345");
    ok("explicit bytes=1234-2345 → 206 with the exact slice", c.status === 206 && c.range === `bytes 1234-2345/${SIZE}` && c.length === "1112" && c.body.equals(files[VOICE].subarray(1234, 2346)));
    const d = await call(VOICE, `bytes=${SIZE - 1}-${SIZE - 1}`);
    ok("last byte only → 206, 1 byte", d.status === 206 && d.range === `bytes ${SIZE - 1}-${SIZE - 1}/${SIZE}` && d.body.length === 1);
    const e = await call(VOICE, `bytes=${SIZE}-`);
    ok("start at EOF → 416 with Content-Range bytes */5000", e.status === 416 && e.range === `bytes */${SIZE}`);
    const f = await call(VOICE, "bytes=3000-2000");
    ok("start > end → 416", f.status === 416 && f.range === `bytes */${SIZE}`);
  }

  // ── 3. Parity with the existing video branch ────────────────────────────────
  console.log("\n3. .m4a range handling identical to video (.mp4)");
  for (const range of ["bytes=0-1", "bytes=1000-", "bytes=1234-2345", `bytes=${SIZE}-`, `bytes=4990-9999`, "bytes=0-1,5-9", "bytes=-100", "bytes=abc", "items=0-1"]) {
    const m = await call(VOICE, range), v = await call("video.mp4", range);
    ok(`${range.padEnd(16)} → m4a ${m.status} / mp4 ${v.status}, same range headers`, m.status === v.status && m.range === v.range && m.length === v.length);
  }

  // ── 4. Existing types unchanged ─────────────────────────────────────────────
  console.log("\n4. Existing image / video / unknown types");
  {
    const jpg = await call("img.jpg"), webp = await call("img.webp");
    ok("img.jpg → 200 image/jpeg, full body", jpg.status === 200 && jpg.type === "image/jpeg" && jpg.body.equals(files["img.jpg"]));
    ok("img.webp → 200 image/webp", webp.status === 200 && webp.type === "image/webp");
    const jpgR = await call("img.jpg", "bytes=0-1");
    ok("img.jpg with Range → still 200 full file (no range support for images)", jpgR.status === 200 && jpgR.body.length === SIZE && jpgR.range === null);
    const mp4 = await call("video.mp4"), mp4R = await call("video.mp4", "bytes=10-19");
    ok("video.mp4 → 200 video/mp4 full; bytes=10-19 → 206 exact slice", mp4.status === 200 && mp4.type === "video/mp4" && mp4R.status === 206 && mp4R.range === `bytes 10-19/${SIZE}` && mp4R.body.equals(files["video.mp4"].subarray(10, 20)));
    const xyz = await call("file.xyz"), xyzR = await call("file.xyz", "bytes=0-1");
    ok("unknown .xyz → 200 application/octet-stream (fallback unchanged)", xyz.status === 200 && xyz.type === "application/octet-stream");
    ok("unknown .xyz with Range → 200 full file (ranges not extended)", xyzR.status === 200 && xyzR.body.length === SIZE && xyzR.range === null);
  }

  // ── 5. Path traversal / missing ─────────────────────────────────────────────
  console.log("\n5. Path validation");
  {
    const t1 = await call("../secret.m4a");
    ok("../secret.m4a → 403, file outside public/uploads not served", t1.status === 403 && !t1.body.equals(bytes(9)));
    const t2 = await call("demo/../../secret.m4a", "bytes=0-1");
    ok("nested ../ with a Range header → 403", t2.status === 403);
    const t3 = await GET(new Request("http://local/uploads//etc/passwd"), { params: Promise.resolve({ path: ["", "etc", "passwd"] }) });
    ok("absolute path segment → 403", t3.status === 403);
    ok("missing .m4a → 404", (await call("demo/chat/audio/missing.m4a")).status === 404);
    ok("empty path → 404", (await GET(new Request("http://local/uploads/"), { params: Promise.resolve({ path: [] }) })).status === 404);
  }
} catch (e) {
  fail++;
  console.log("  FAIL  unexpected error:", e?.stack || e);
} finally {
  cleanup();
  ok("temporary directory removed", !existsSync(root));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
