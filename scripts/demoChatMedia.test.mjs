#!/usr/bin/env node
/**
 * scripts/demoChatMedia.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-3 — DEMO chat media assets (images + voice notes).
 * No database, no network, no real ffprobe: storage, the DB and ffprobe are
 * fakes; images are real sharp-encoded buffers; audio fixtures are built
 * byte-for-byte (MPEG frames, ISO-BMFF boxes, Ogg pages with real CRCs).
 * Proves:
 *   • content-based validation (magic bytes + full decode/parse); client name,
 *     extension, MIME type and claimed duration are never used
 *   • images re-encoded to WebP, resized, metadata stripped, polyglots removed,
 *     GIF/SVG/HTML/animated/oversized/tiny/corrupt/bomb rejected
 *   • voice notes: MP3/M4A/Ogg(Opus,Vorbis) durations, 5 MB and 3 min limits,
 *     malformed/truncated/mixed/video/unsupported rejected, ID3 stripped,
 *     ffprobe cross-check (agree / disagree / longer / failure)
 *   • lifecycle: generated keys, dedupe, storage failure, DB failure with
 *     compensation (and logged orphan), audit, kind checks on steps,
 *     published-version retention, safe delete
 *   • admin-only routes; gates unaffected; nothing outside demo chat touched
 * Run: node scripts/demoChatMedia.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import sharp from "sharp";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";

const M = await import("../src/lib/demoChatMedia.js");
const V = await import("../src/lib/demoChatValidation.js");
const G = await import("../src/lib/demoChatGate.js");
const R2 = await import("../src/lib/r2.js");
const demo = await import("../src/lib/services/demoService.js");
const svc = await import("../src/lib/services/demoChatService.js");
const E = await import("../src/lib/demoChatErrors.js");
const { withAdminAuth } = await import("../src/lib/middleware/withAdminAuth.js");
const { signToken } = await import("../src/lib/services/authService.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (p) => Promise.resolve().then(() => p()).then(() => null, (e) => e);
// Mock transcoder (external process mocked): returns a valid canonical AAC/M4A of the input's duration
// and records what it was given. The real ffmpeg path is exercised in section 6.
const txSeen = [];
const MOCK_TX = { available: async () => true, transcode: async (buf, opts) => { txSeen.push({ buf, ...opts }); return m4a(opts.durationSec); } };
const NO_PROBE = { probeAvailable: () => false, transcoder: MOCK_TX };
const quiet = async (fn) => { const o = console.error; const logs = []; console.error = (...a) => logs.push(a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")); try { return { result: await fn(), logs }; } finally { console.error = o; } };

// ── Fixtures: images ──────────────────────────────────────────────────────────
const img = (w, h, fmt, opts = {}) => {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 90 } } });
  if (opts.exif) p = p.withMetadata({ exif: { IFD0: { Copyright: "SECRET-GPS-OWNER", Artist: "camera-owner" } } });
  return p[fmt]().toBuffer();
};
const PNG = await img(400, 300, "png");
const JPEG = await img(400, 300, "jpeg", { exif: true });
const WEBP = await img(400, 300, "webp");
const BIG = await img(2400, 1200, "jpeg");
const TINY = await img(8, 8, "png");
const GIF = await img(64, 64, "gif");

// ── Fixtures: audio ───────────────────────────────────────────────────────────
// MPEG-1 Layer III, 44.1 kHz mono, constant bitrate. 1152 samples per frame.
const mp3Frame = (brIdx = 1) => {
  const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][brIdx];
  const len = Math.floor((144 * kbps * 1000) / 44100);
  const f = Buffer.alloc(len); f.writeUInt32BE((0xfffb0000 | (brIdx << 12) | (3 << 6)) >>> 0, 0); return f;
};
const id3v2 = (payload) => {
  const size = payload.length; const h = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  return Buffer.concat([h, payload]);
};
const mp3 = (seconds, { brIdx = 1, tagV2 = false, tagV1 = false } = {}) => {
  const frames = Math.floor((seconds * 44100) / 1152); const f = mp3Frame(brIdx); // whole frames that fit
  const parts = [];
  if (tagV2) parts.push(id3v2(Buffer.concat([Buffer.from("APIC"), Buffer.alloc(2000, 7)])));
  for (let i = 0; i < frames; i++) parts.push(f);
  if (tagV1) parts.push(Buffer.concat([Buffer.from("TAG"), Buffer.alloc(125, 32)]));
  return Buffer.concat(parts);
};
// ISO-BMFF
const box = (type, ...kids) => { const body = Buffer.concat(kids.map((k) => (Buffer.isBuffer(k) ? k : Buffer.from(k)))); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
const mvhd = (timescale, duration) => { const b = Buffer.alloc(100); b.writeUInt32BE(timescale, 12); b.writeUInt32BE(duration, 16); return box("mvhd", b); };
const hdlr = (h) => { const b = Buffer.alloc(25); b.write(h, 8, "latin1"); return box("hdlr", b); };
const stsd = (fourcc) => { const head = Buffer.alloc(8); head.writeUInt32BE(1, 4); const entry = Buffer.alloc(36); entry.writeUInt32BE(36, 0); entry.write(fourcc, 4, "latin1"); return box("stsd", head, entry); };
const trak = (handler, fourcc) => box("trak", box("mdia", box("mdhd", Buffer.alloc(24)), hdlr(handler), box("minf", box("stbl", stsd(fourcc)))));
const m4a = (seconds, { video = false, codec = "mp4a", duration } = {}) => Buffer.concat([
  box("ftyp", Buffer.from("M4A \0\0\0\0M4A isom", "latin1")),
  box("moov", mvhd(1000, duration ?? Math.round(seconds * 1000)), trak("soun", codec), ...(video ? [trak("vide", "avc1")] : [])),
  box("mdat", Buffer.alloc(4000, 1)),
]);
// Ogg pages with real CRC-32
const oggPage = (type, granule, serial, seq, body) => {
  const segs = []; let n = body.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n);
  const h = Buffer.alloc(27 + segs.length);
  h.write("OggS", 0, "ascii"); h[4] = 0; h[5] = type; h.writeBigInt64LE(BigInt(granule), 6); h.writeUInt32LE(serial, 14); h.writeUInt32LE(seq, 18); h[26] = segs.length; segs.forEach((s, i) => { h[27 + i] = s; });
  const page = Buffer.concat([h, body]); page.writeUInt32LE(M.oggCrc(page), 22); return page;
};
const opusHead = (preSkip = 312) => { const b = Buffer.alloc(19); b.write("OpusHead", 0, "ascii"); b[8] = 1; b[9] = 1; b.writeUInt16LE(preSkip, 10); b.writeUInt32LE(48000, 12); return b; };
const vorbisHead = (rate = 44100) => { const b = Buffer.alloc(30); b[0] = 1; b.write("vorbis", 1, "ascii"); b[11] = 1; b.writeUInt32LE(rate, 12); b[28] = 0xb8; b[29] = 1; return b; };
const ogg = (seconds, { codec = "opus", serial = 77, preSkip = 312, otherSerialAt = -1, badCrcAt = -1 } = {}) => {
  const rate = codec === "opus" ? 48000 : 44100;
  const pages = [oggPage(2, 0, serial, 0, codec === "opus" ? opusHead(preSkip) : vorbisHead(rate)), oggPage(0, 0, serial, 1, Buffer.from(codec === "opus" ? "OpusTags\0\0\0\0\0\0\0\0" : "\x03vorbis"))];
  const total = Math.round(seconds * rate) + (codec === "opus" ? preSkip : 0);
  for (let i = 1; i <= 4; i++) pages.push(oggPage(i === 4 ? 4 : 0, Math.round((total * i) / 4), i - 1 === otherSerialAt ? serial + 1 : serial, i + 1, Buffer.alloc(600, i)));
  if (badCrcAt >= 0) pages[badCrcAt][40] ^= 0xff;
  return Buffer.concat(pages);
};

const smuggleMp3 = () => { const len = Math.floor((144 * 32000) / 44100); const fr = []; for (let i = 0; i < 300; i++) { const f = Buffer.alloc(len); f.writeUInt32BE((0xfffb0000 | (1 << 12) | (3 << 6)) >>> 0, 0); f.write("<script>alert(1)</script>", 8); fr.push(f); } return Buffer.concat(fr); };

// ── 1. Images ─────────────────────────────────────────────────────────────────
console.log("\n1. Images (content-based, re-encoded)");
{
  for (const [name, buf, fmt] of [["PNG", PNG, "png"], ["JPEG", JPEG, "jpeg"], ["WEBP", WEBP, "webp"]]) {
    const r = await M.processChatImage(buf);
    const meta = await sharp(r.buffer).metadata();
    ok(`${name} accepted → re-encoded WebP (${r.width}×${r.height})`, r.format === "webp" && r.inputFormat === fmt && meta.format === "webp" && r.mimeType === "image/webp" && r.width === 400 && r.height === 300);
  }
  const jMeta = await sharp(JPEG).metadata();
  const out = await M.processChatImage(JPEG);
  const oMeta = await sharp(out.buffer).metadata();
  ok("EXIF metadata present in input, stripped from output", !!jMeta.exif && !oMeta.exif && !oMeta.xmp && !out.buffer.includes(Buffer.from("SECRET-GPS-OWNER")));
  const big = await M.processChatImage(BIG);
  ok("large image resized to fit 1600 px", big.width === 1600 && big.height === 800);
  const poly = Buffer.concat([PNG, Buffer.from("<script>alert(1)</script><html>")]);
  const pOut = await M.processChatImage(poly).catch((e) => e);
  ok("polyglot (PNG + trailing script) → payload not in stored bytes", !pOut.mediaError ? !pOut.buffer.includes(Buffer.from("<script>")) : pOut.code === "INVALID_IMAGE");
  const cases = [
    ["GIF", GIF, "UNSUPPORTED_IMAGE"],
    ["SVG markup", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "UNSUPPORTED_IMAGE"],
    ["HTML claiming to be an image", Buffer.from("<!DOCTYPE html><html><body>hi</body></html>"), "UNSUPPORTED_IMAGE"],
    ["MP3 bytes uploaded as image", mp3(2), "UNSUPPORTED_IMAGE"],
    ["random bytes", Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 37) % 251)), "UNSUPPORTED_IMAGE"],
    ["truncated PNG", PNG.subarray(0, 200), "INVALID_IMAGE"],
    ["PNG header + garbage body", Buffer.concat([PNG.subarray(0, 33), Buffer.alloc(300, 9)]), "INVALID_IMAGE"],
    ["8×8 image (too small)", TINY, "IMAGE_TOO_SMALL"],
    ["empty file", Buffer.alloc(0), "EMPTY_FILE"],
    ["over 10 MB", Buffer.concat([PNG.subarray(0, 16), Buffer.alloc(V.IMAGE_MAX_UPLOAD_BYTES)]), "FILE_TOO_LARGE"],
  ];
  for (const [name, buf, code] of cases) ok(`${name} → ${code}`, (await rejects(() => M.processChatImage(buf)))?.code === code);
  // Decompression bomb: tiny file, huge pixel count.
  const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png({ compressionLevel: 9, palette: true }).toBuffer();
  ok(`decompression bomb (${(bomb.length / 1024).toFixed(0)} KB, 48 MP) → rejected`, bomb.length < 1024 * 1024 && (await rejects(() => M.processChatImage(bomb)))?.code === "INVALID_IMAGE");
  let animated = null;
  try { animated = await sharp([PNG, await img(400, 300, "png", {}).then(() => sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 90, b: 90 } } }).png().toBuffer())], { join: { animated: true } }).webp().toBuffer(); } catch { animated = null; } // two DIFFERENT frames (identical ones are merged)
  if (animated) ok("animated WebP → ANIMATED_IMAGE", (await rejects(() => M.processChatImage(animated)))?.code === "ANIMATED_IMAGE");
  else ok("animated WebP check (fixture unavailable in this sharp build — guard is the pages>1 check)", /pages \|\| 1\) > 1/.test(src("src/lib/demoChatMedia.js")));
  ok("sniffImageFormat ignores names: content only", M.sniffImageFormat(PNG) === "png" && M.sniffImageFormat(JPEG) === "jpeg" && M.sniffImageFormat(WEBP) === "webp" && M.sniffImageFormat(GIF) === "gif");
}

// ── 2. Voice notes ────────────────────────────────────────────────────────────
console.log("\n2. Voice notes (format + duration from the bytes)");
{
  const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
  let r = await M.processVoiceNote(mp3(12), NO_PROBE);
  ok(`MP3 12 s → transcoded to canonical m4a/aac (${r.durationSec}s, audio/mp4)`, r.inputFormat === "mp3" && r.format === "m4a" && r.codec === "aac" && near(r.durationSec, 12) && r.mimeType === "audio/mp4" && r.ext === "m4a" && r.validator === "js+ffmpeg");
  const tagged = mp3(5, { tagV2: true, tagV1: true });
  r = await M.processVoiceNote(tagged, NO_PROBE);
  const fed = txSeen.at(-1).buf;
  ok("ID3v2 (with cover art) + ID3v1 cut off before transcoding; only the transcoded output is returned", fed.length === tagged.length - (10 + 2004) - 128 && !fed.includes(Buffer.from("APIC")) && fed.subarray(0, 2).equals(Buffer.from([0xff, 0xfb])) && !r.buffer.equals(fed) && r.buffer.toString("latin1", 4, 8) === "ftyp");
  r = await M.processVoiceNote(m4a(42.5), NO_PROBE);
  ok(`M4A (AAC) 42.5 s → m4a, audio/mp4`, r.format === "m4a" && r.codec === "aac" && near(r.durationSec, 42.5) && r.mimeType === "audio/mp4");
  r = await M.processVoiceNote(ogg(30), NO_PROBE);
  ok("Ogg Opus 30 s (pre-skip removed) → input ogg/opus, stored audio/mp4", r.inputFormat === "ogg" && r.inputCodec === "opus" && near(r.inputDurationSec, 30) && r.mimeType === "audio/mp4");
  r = await M.processVoiceNote(ogg(20, { codec: "vorbis" }), NO_PROBE);
  ok("Ogg Vorbis 20 s → input ogg/vorbis", r.inputCodec === "vorbis" && near(r.inputDurationSec, 20));
  ok("exactly 180 s accepted (MP3, M4A, Ogg)", (await Promise.all([mp3(180), m4a(180), ogg(180)].map((b) => M.processVoiceNote(b, NO_PROBE)))).every((x) => x.durationSec <= 180));
  const cases = [
    ["MP3 181 s", mp3(181), "TOO_LONG"],
    ["M4A 180.5 s", m4a(180.5), "TOO_LONG"],
    ["Ogg 200 s", ogg(200), "TOO_LONG"],
    ["MP3 0.2 s", mp3(0.2), "TOO_SHORT"],
    ["over 5 MB", Buffer.concat([mp3(1), Buffer.alloc(V.AUDIO_MAX_BYTES)]), "FILE_TOO_LARGE"],
    ["empty", Buffer.alloc(0), "EMPTY_FILE"],
    ["WAV (RIFF)", Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(200)]), "UNSUPPORTED_AUDIO"],
    ["HTML claiming audio/mpeg", Buffer.from("<html><script>alert(1)</script></html>"), "UNSUPPORTED_AUDIO"],
    ["PNG image uploaded as audio", PNG, "UNSUPPORTED_AUDIO"],
    ["truncated MP3 (last frame cut)", mp3(10).subarray(0, mp3(10).length - 50), "INVALID_AUDIO"],
    ["MP3 + trailing junk", Buffer.concat([mp3(5), Buffer.from("<script>evil()</script>")]), "INVALID_AUDIO"],
    ["MP3 sync bytes only", Buffer.from([0xff, 0xfb, 0x10, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0]), "INVALID_AUDIO"],
    ["M4A with a video track", m4a(10, { video: true }), "INVALID_AUDIO"],
    ["M4A with unsupported codec", m4a(10, { codec: "alac" }), "INVALID_AUDIO"],
    ["M4A without duration (mvhd = 0)", m4a(10, { duration: 0 }), "INVALID_AUDIO"],
    ["M4A truncated (box overruns file)", m4a(10).subarray(0, 500), "INVALID_AUDIO"],
    ["Ogg with corrupted page (CRC)", ogg(10, { badCrcAt: 3 }), "INVALID_AUDIO"],
    ["Ogg with two multiplexed streams", ogg(10, { otherSerialAt: 2 }), "INVALID_AUDIO"],
    ["Ogg truncated mid-page", ogg(10).subarray(0, ogg(10).length - 100), "INVALID_AUDIO"],
    ["Ogg Speex (unsupported codec)", Buffer.concat([oggPage(2, 0, 5, 0, Buffer.from("Speex   " + "x".repeat(72))), oggPage(4, 48000, 5, 1, Buffer.alloc(10))]), "INVALID_AUDIO"],
  ];
  for (const [name, buf, code] of cases) ok(`${name} → ${code}`, (await rejects(() => M.processVoiceNote(buf, NO_PROBE)))?.code === code);
  ok("client-reported duration cannot be passed in (signature takes bytes + probe deps only)", M.processVoiceNote.length <= 2 && !/duration/i.test(src("src/app/api/admin/demo-chat/assets/route.js").replace(/3 min|durée/gi, "")));

  // ffprobe as an independent second check (injected).
  const probe = (over) => ({ transcoder: MOCK_TX, probeAvailable: () => true, runProbe: (b, fmt) => ({ format: fmt, durationSec: 12, audioStreams: 1, videoStreams: 0, ...over }) });
  r = await M.processVoiceNote(mp3(12), probe());
  ok("ffprobe agrees (input and output) → validator js+ffprobe+ffmpeg", r.validator === "js+ffprobe+ffmpeg" && near(r.durationSec, 12));
  ok("ffprobe disagrees on duration → INVALID_AUDIO", (await rejects(() => M.processVoiceNote(mp3(12), probe({ durationSec: 30 }))))?.code === "INVALID_AUDIO");
  ok("ffprobe disagrees on format → INVALID_AUDIO", (await rejects(() => M.processVoiceNote(mp3(12), probe({ format: "ogg" }))))?.code === "INVALID_AUDIO");
  ok("ffprobe sees a video stream → INVALID_AUDIO", (await rejects(() => M.processVoiceNote(mp3(12), probe({ videoStreams: 1 }))))?.code === "INVALID_AUDIO");
  ok("ffprobe cannot read the file → INVALID_AUDIO", (await rejects(() => M.processVoiceNote(mp3(12), { probeAvailable: () => true, runProbe: () => { throw new Error("boom"); } })))?.code === "INVALID_AUDIO");
  ok("ffprobe has no duration → NO_DURATION", (await rejects(() => M.processVoiceNote(mp3(12), probe({ durationSec: NaN }))))?.code === "NO_DURATION");
  ok("longer of the two durations is enforced (JS 179 s, ffprobe 181 s → TOO_LONG)", (await rejects(() => M.processVoiceNote(mp3(179), probe({ durationSec: 181 }))))?.code === "TOO_LONG");
  ok("ffprobe normalisation (attached cover art is not a video stream)",
    M.normalizeProbe({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "9.5" }, streams: [{ codec_type: "audio" }, { codec_type: "video", disposition: { attached_pic: 1 } }] }).videoStreams === 0
    && M.normalizeProbe({ format: { format_name: "ogg" } }).format === "ogg");
}

// ── 3. Lifecycle (fake DB + fake storage) ─────────────────────────────────────
console.log("\n3. Asset lifecycle");
const known = (code) => Object.assign(new Error(code), { code, name: "PrismaClientKnownRequestError" });
function makeDb() {
  let seq = 1; const nid = () => `id_${String(seq++).padStart(4, "0")}`;
  const t = { demoChatJourney: [], demoChatJourneyStep: [], demoChatJourneyVersion: [], demoChatVersionAsset: [], demoChatAuditLog: [], demoChatAsset: [], demoChatMessage: [], setting: [] };
  const fx = { failAssetCreate: false, failAuditOnce: false, beforeAssetCreate: null };
  const match = (r, w = {}) => Object.entries(w).every(([k, c]) => (c instanceof Date ? r[k] instanceof Date && r[k].getTime() === c.getTime() : r[k] === c));
  const sortBy = (rows, o) => { const l = Array.isArray(o) ? o : o ? [o] : []; return [...rows].sort((a, b) => { for (const x of l) { const [k, d] = Object.entries(x)[0]; const c = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0; if (c) return d === "desc" ? -c : c; } return 0; }); };
  const refs = (id) => t.demoChatJourneyStep.some((s) => s.assetId === id) || t.demoChatVersionAsset.some((v) => v.assetId === id) || t.demoChatMessage.some((m) => m.assetId === id);
  const model = (name) => ({
    findMany: async ({ where, orderBy, select } = {}) => sortBy(t[name].filter((x) => match(x, where)), orderBy).map((x) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, x[k]])) : { ...x })),
    findUnique: async ({ where }) => { const r = t[name].find((x) => match(x, where)); return r ? { ...r } : null; },
    findFirst: async ({ where, orderBy } = {}) => { const r = sortBy(t[name].filter((x) => match(x, where)), orderBy)[0]; return r ? { ...r } : null; },
    count: async ({ where } = {}) => t[name].filter((x) => match(x, where)).length,
    create: async ({ data }) => {
      if (name === "demoChatAsset") {
        if (fx.beforeAssetCreate) { const h = fx.beforeAssetCreate; fx.beforeAssetCreate = null; await h(); }
        if (fx.failAssetCreate) throw new Error("db write failed (simulated)");
        if (t.demoChatAsset.some((a) => a.sha256 === data.sha256)) throw known("P2002");
        if (data.kind === "audio" && !(data.durationSec > 0 && data.durationSec <= 180 && data.bytes <= 5242880)) throw new Error('PostgresError { code: "23514", message: "violates check constraint" }');
      }
      if (name === "demoChatAuditLog" && fx.failAuditOnce) { fx.failAuditOnce = false; throw new Error("audit failed (simulated)"); }
      if (name === "demoChatJourneyStep" && data.assetId && !t.demoChatAsset.some((a) => a.id === data.assetId)) throw known("P2003");
      if (name === "demoChatVersionAsset" && !t.demoChatAsset.some((a) => a.id === data.assetId)) throw known("P2003");
      const row = { id: data.id ?? nid(), ...data };
      if (name === "demoChatJourney") { row.status ??= "draft"; row.description ??= ""; }
      if (name === "demoChatJourneyStep") row.position ??= 0;
      if (name === "demoChatJourneyVersion") row.steps = structuredClone(data.steps);
      t[name].push(row); return { ...row };
    },
    update: async ({ where, data }) => { if (name === "demoChatAuditLog") throw new Error("append-only"); const r = t[name].find((x) => match(x, where)); if (!r) throw known("P2025"); Object.assign(r, data); return { ...r }; },
    delete: async ({ where }) => {
      if (name === "demoChatAuditLog") throw new Error("append-only");
      const i = t[name].findIndex((x) => match(x, where)); if (i < 0) throw known("P2025");
      if (name === "demoChatAsset" && refs(t[name][i].id)) throw known("P2003"); // FK RESTRICT backstop
      if (name === "demoChatJourneyStep") { /* no FK on steps */ }
      const [r] = t[name].splice(i, 1); return r;
    },
  });
  const models = Object.fromEntries(Object.keys(t).filter((k) => k !== "setting").map((k) => [k, model(k)]));
  models.setting = { findUnique: async ({ where }) => { if (where.id !== G.DEMO_CHAT_SETTING_ID) throw new Error("TEST: forbidden setting"); return t.setting.find((s) => s.id === where.id) || null; } };
  const guard = (o) => new Proxy(o, { get: (x, k) => { if (k in x || typeof k === "symbol" || k === "then") return x[k]; throw new Error(`TEST: forbidden model ${String(k)}`); } });
  const db = guard({
    ...models, _t: t, _fx: fx,
    $transaction: async (fn) => {
      const snap = structuredClone(t);
      const tx = guard({ ...models, $queryRaw: async (strings, ...vals) => {
        const sql = strings.join("?");
        if (/FROM "demo_chat_journeys"[\s\S]*FOR UPDATE/.test(sql)) return t.demoChatJourney.filter((j) => j.id === vals[0]).map((j) => ({ id: j.id, status: j.status, updatedAt: j.updatedAt }));
        if (/FROM "demo_chat_assets"[\s\S]*FOR UPDATE/.test(sql)) return t.demoChatAsset.filter((a) => a.id === vals[0]).map((a) => ({ id: a.id }));
        throw new Error(`TEST: unexpected SQL ${sql}`);
      } });
      // Rollback undoes OUR writes only; rows committed by a concurrent request (_external) survive.
      try { return await fn(tx); } catch (e) { for (const k of Object.keys(t)) t[k] = [...snap[k], ...t[k].filter((r) => r._external)]; throw e; }
    },
  });
  return db;
}
function makeStorage() {
  const s = { saved: [], destroyed: [], failSave: false, failDestroy: false };
  s.api = {
    save: async (buffer, opts) => { if (s.failSave) throw new Error("R2 unreachable (simulated)"); const key = `site/${opts.category}/${opts.filename}`; s.saved.push({ key, opts, bytes: buffer.length }); return { storage: "r2", url: `https://media.example.test/${key}`, key }; },
    destroy: async (url) => { if (s.failDestroy) throw new Error("delete failed (simulated)"); s.destroyed.push(url); return { ok: true }; },
  };
  return s;
}
let clock = Date.UTC(2026, 9, 24, 10, 0);
const ctx = () => ({ actorId: "admin-1", now: (clock += 1000) });
const db = makeDb(); demo.__setDemoDb(db);
const store = makeStorage(); svc.__setDemoChatStorage(store.api);
svc.__setDemoChatAudioDeps(NO_PROBE);
{
  const up = await svc.uploadAsset("image", PNG, ctx());
  const s0 = store.saved[0];
  ok("image upload → 201 semantics, one stored object, DB row, audit ASSET_UPLOAD",
    !up.deduplicated && store.saved.length === 1 && db._t.demoChatAsset.length === 1 && db._t.demoChatAuditLog.at(-1).action === "ASSET_UPLOAD" && db._t.demoChatAuditLog.at(-1).actorId === "admin-1");
  ok("generated key: demo-chat-images/<uuid>.webp, never the client filename", /^[0-9a-f-]{36}\.webp$/.test(s0.opts.filename) && s0.opts.category === "demo-chat-images" && s0.opts.subdir === "demo/chat/images" && s0.opts.deterministic === true);
  ok("explicit safe Content-Type (image/webp) passed to storage", s0.opts.contentType === "image/webp");
  const row = db._t.demoChatAsset[0];
  ok("row: kind/mime/format/bytes/sha256/dimensions/storageKey/createdBy", row.kind === "image" && row.mimeType === "image/webp" && row.formatDetected === "png" && row.bytes === s0.bytes && /^[0-9a-f]{64}$/.test(row.sha256) && row.width === 400 && row.storageKey === s0.key && row.createdBy === "admin-1");
  const again = await svc.uploadAsset("image", PNG, ctx());
  ok("same content again → deduplicated, nothing stored, no audit", again.deduplicated && again.asset.id === up.asset.id && store.saved.length === 1 && db._t.demoChatAuditLog.length === 1);

  const bad = await rejects(() => svc.uploadAsset("image", Buffer.from("<html>")));
  ok("invalid content → 415, nothing stored, no row, no audit", bad?.status === 415 && store.saved.length === 1 && db._t.demoChatAsset.length === 1 && db._t.demoChatAuditLog.length === 1);
  ok("unknown kind → 400", (await rejects(() => svc.uploadAsset("video", PNG)))?.status === 400);

  store.failSave = true;
  const sf = await quiet(() => rejects(() => svc.uploadAsset("image", JPEG, ctx())));
  store.failSave = false;
  ok("storage failure → 502 STORAGE_FAILED, no row, no audit", sf.result?.code === "STORAGE_FAILED" && sf.result.status === 502 && db._t.demoChatAsset.length === 1);

  db._fx.failAssetCreate = true;
  const df = await quiet(() => rejects(() => svc.uploadAsset("image", JPEG, ctx())));
  db._fx.failAssetCreate = false;
  ok("DB failure after storing → stored object deleted (compensation), 500, no row", df.result?.status === 500 && store.destroyed.length === 1 && store.destroyed[0] === `https://media.example.test/${store.saved.at(-1).key}` && db._t.demoChatAsset.length === 1);

  db._fx.failAuditOnce = true;
  const af = await quiet(() => rejects(() => svc.uploadAsset("image", JPEG, ctx())));
  ok("audit failure rolls back the row AND removes the stored object", af.result?.status === 500 && db._t.demoChatAsset.length === 1 && store.destroyed.length === 2);

  db._fx.failAssetCreate = true; store.failDestroy = true;
  const orphan = await quiet(() => rejects(() => svc.uploadAsset("image", JPEG, ctx())));
  db._fx.failAssetCreate = false; store.failDestroy = false;
  ok("DB failure + delete failure → error returned and orphan logged with its key", orphan.result?.status === 500 && orphan.logs.some((l) => /ORPHANED OBJECT/.test(l) && l.includes(store.saved.at(-1).key)));

  // Concurrent upload of identical content: the other request inserted first.
  const racer = await M.processChatImage(WEBP);
  db._fx.beforeAssetCreate = async () => { db._t.demoChatAsset.push({ _external: true, id: "winner", kind: "image", url: "https://media.example.test/w", sha256: (await import("node:crypto")).createHash("sha256").update(racer.buffer).digest("hex"), mimeType: "image/webp", formatDetected: "webp", bytes: racer.bytes, width: 400, height: 300 }); };
  const race = await quiet(() => svc.uploadAsset("image", WEBP, ctx()));
  ok("unique-key race → returns the winner, removes our duplicate object", race.result.deduplicated && race.result.asset.id === "winner" && store.destroyed.at(-1) === `https://media.example.test/${store.saved.at(-1).key}`);

  const au = await svc.uploadAsset("audio", mp3(20, { tagV2: true }), ctx());
  const as = store.saved.at(-1);
  ok("voice note → demo-chat-audio/<uuid>.m4a, audio/mp4 (transcoded), duration stored", au.asset.kind === "audio" && /^[0-9a-f-]{36}\.m4a$/.test(as.opts.filename) && as.opts.category === "demo-chat-audio" && as.opts.subdir === "demo/chat/audio" && as.opts.contentType === "audio/mp4" && Math.abs(au.asset.durationSec - 20) < 0.05 && au.asset.formatDetected === "mp3/mp3→m4a/aac" && au.asset.mimeType === "audio/mp4");
  ok("voice note over 3 min → 413, nothing stored", (await rejects(() => svc.uploadAsset("audio", mp3(185))))?.status === 413 && store.saved.at(-1) === as);
  const ogA = await svc.uploadAsset("audio", ogg(15), ctx());
  ok("Ogg voice note stored transcoded as audio/mp4", store.saved.at(-1).opts.contentType === "audio/mp4" && ogA.asset.formatDetected === "ogg/opus→m4a/aac");

  // Steps referencing assets
  let J = await svc.createJourney({ name: "Médias" }, ctx());
  J = await svc.createStep(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, day: 1, time: "09:00", type: "image", assetId: up.asset.id, text: "Regardez !" }, ctx());
  ok("image step with an image asset", J.steps[0].assetId === up.asset.id && J.assets[up.asset.id]?.url === up.asset.url);
  ok("audio step pointing at an image → 400 ASSET_KIND", (await rejects(() => svc.createStep(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, day: 1, time: "10:00", type: "audio", assetId: up.asset.id }, ctx())))?.code === "ASSET_KIND");
  ok("caption with a hand-typed amount → 400", (await rejects(() => svc.createStep(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, day: 1, time: "10:00", type: "audio", assetId: au.asset.id, text: "J'ai gagné 300 MAD" }, ctx())))?.field === "text");
  J = await svc.createStep(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, day: 2, time: "18:00", type: "audio", assetId: au.asset.id }, ctx());
  ok("audio step without caption", J.steps.find((s) => s.type === "audio").text === null);

  const preview = await svc.previewTimeline({ journeyId: J.journey.id });
  ok("preview carries the asset (url, kind, duration) and writes nothing", preview.days[0].messages[0].asset?.url === up.asset.url && preview.days[1].messages[0].asset?.durationSec === au.asset.durationSec);

  const inDraft = await rejects(() => svc.deleteAsset(up.asset.id, ctx()));
  ok("delete asset used by a draft step → 409 ASSET_IN_USE, storage untouched", inDraft?.code === "ASSET_IN_USE" && !store.destroyed.includes(up.asset.url));
  const pub = await svc.publishJourney(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt }, ctx());
  ok("publish links both assets to the version", db._t.demoChatVersionAsset.filter((v) => v.versionId === pub.version.id).length === 2);
  let cur = await svc.getJourney(J.journey.id);
  const imgStep = cur.steps.find((s) => s.type === "image");
  cur = await svc.deleteStep(J.journey.id, imgStep.id, { expectedUpdatedAt: cur.journey.updatedAt }, ctx());
  const inVersion = await rejects(() => svc.deleteAsset(up.asset.id, ctx()));
  ok("asset still used by a PUBLISHED version → 409, row and object kept", inVersion?.code === "ASSET_IN_USE" && /1 version/.test(inVersion.message) && db._t.demoChatAsset.some((a) => a.id === up.asset.id) && !store.destroyed.includes(up.asset.url));

  const list = await svc.listAssets();
  const li = list.assets.find((a) => a.id === up.asset.id);
  ok("library lists usage and deletable flags", li.usage.versions === 1 && li.usage.steps === 0 && li.deletable === false && list.assets.find((a) => a.id === ogA.asset.id).deletable === true);
  ok("library filter by kind", (await svc.listAssets({ kind: "audio" })).assets.every((a) => a.kind === "audio") && (await rejects(() => svc.listAssets({ kind: "pdf" })))?.status === 400);

  const del = await svc.deleteAsset(ogA.asset.id, ctx());
  ok("delete unused asset → row removed, audit ASSET_DELETE, object removed", del.deleted && !db._t.demoChatAsset.some((a) => a.id === ogA.asset.id) && db._t.demoChatAuditLog.at(-1).action === "ASSET_DELETE" && store.destroyed.includes(ogA.asset.url));
  const extra = await svc.uploadAsset("image", BIG, ctx());
  store.failDestroy = true;
  const delFail = await quiet(() => svc.deleteAsset(extra.asset.id, ctx()));
  store.failDestroy = false;
  ok("object delete failure after row delete → still deleted, logged for manual cleanup", delFail.result.deleted && !delFail.result.storage.ok && delFail.logs.some((l) => /not removed/.test(l)));
  ok("unknown / invalid id → 404", (await rejects(() => svc.deleteAsset("nope", ctx())))?.status === 404 && (await rejects(() => svc.deleteAsset("../x", ctx())))?.status === 404);
  // FK backstop: even if the usage check were bypassed, RESTRICT refuses.
  ok("FK RESTRICT backstop maps to 409", E.toHttpError(known("P2003")).status === 409);
  ok("audit rows only ever inserted", db._t.demoChatAuditLog.every((a) => a.action));
  svc.__setDemoChatStorage(null); svc.__setDemoChatAudioDeps(null);
}

// ── 4. Routes, gates, storage conventions, isolation ──────────────────────────
console.log("\n4. Routes, gates, storage conventions, isolation");
{
  const r1 = src("src/app/api/admin/demo-chat/assets/route.js");
  const r2 = src("src/app/api/admin/demo-chat/assets/[id]/route.js");
  const wrapped = (s) => { const m = [...s.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)\(/g)]; return m.length > 0 && m.every((x) => x[2] === "withAdminAuth") && !/export (async )?function/.test(s); };
  ok("asset routes: every method withAdminAuth", wrapped(r1) && wrapped(r2));
  ok("upload route ignores client file name and MIME type", !/file\.(name|type)\b/.test(r1));
  ok("upload route reads the body through the hard streaming limit (never req.formData())", /readFormDataWithLimit\(req, IMAGE_MAX_UPLOAD_BYTES \+ MULTIPART_OVERHEAD\)/.test(r1) && !/req\.formData\(/.test(r1) && /file\.size > limit/.test(r1));
  const req = (cookie) => ({ cookies: { get: () => undefined }, headers: { get: (k) => (k === "cookie" ? cookie : null) } });
  const route = withAdminAuth(async () => Response.json({ ok: true }, { status: 201 }));
  ok("no token → 401; user/affiliate token → 403; admin → allowed",
    (await route(req(""))).status === 401 && (await route(req(`auth_token=${signToken({ userId: "u", role: "USER" })}`))).status === 403
    && (await route(req(`auth_token=${signToken({ affiliateId: "a", type: "affiliate" })}`))).status === 403
    && (await route(req(`auth_token=${signToken({ userId: "adm", role: "ADMIN" })}`))).status === 201);
  ok("gates unchanged by media work: disabled by default", !(await G.isDemoChatEnabled({ setting: { findUnique: async () => null } }, {})));
  const apiFiles = (() => { const out = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = `${d}/${f}`; if (statSync(p).isDirectory()) walk(p); else if (f === "route.js") out.push(p); } }; walk("src/app/api"); return out; })();
  ok("no non-admin API route uses the demo chat service (no affiliate-facing chat yet)", apiFiles.filter((p) => /demoChatService/.test(readFileSync(p, "utf8"))).every((p) => p.includes("/api/admin/demo-chat/")));
  ok("R2 key for a demo voice note: <prefix>/demo-chat-audio/<uuid>.mp3 (no traversal)",
    R2.buildObjectKey({ prefix: "siteA", category: "demo-chat-audio", filename: "0b6f6c1e-1111-4222-8333-444455556666.mp3", deterministic: true }) === "siteA/demo-chat-audio/0b6f6c1e-1111-4222-8333-444455556666.mp3"
    && R2.buildObjectKey({ prefix: "siteA", category: "demo-chat-images", filename: "../../etc/passwd", deterministic: true }) === "siteA/demo-chat-images/passwd");
  const facade = src("src/lib/cloudinary.js");
  ok("storage facade forwards an explicit contentType to R2 (backward compatible)", /category, contentType \} = opts/.test(facade) && /deterministic,\s+contentType,\s+\}\)/.test(facade));
  const newFiles = ["src/lib/demoChatMedia.js", "src/app/api/admin/demo-chat/assets/route.js", "src/app/api/admin/demo-chat/assets/[id]/route.js", "src/app/admin/demo-chat/assets/page.jsx"];
  const banned = /(order|commission|payout|withdraw|deposit|booster|balance|wallet|notification|whatsapp|sms|ugc|reward|fakeOrder|affiliateService|teamBonus|referral)/i;
  ok("new media files import no order/money/messaging/UGC/rewards modules", newFiles.every((p) => [...src(p).matchAll(/from\s+['"]([^'"]+)['"]/g)].every((m) => !banned.test(m[1]))));
  ok("DB CHECK limits match the validation constants (180 s, 5 242 880 bytes)",
    V.AUDIO_MAX_DURATION_SEC === 180 && V.AUDIO_MAX_BYTES === 5242880 && /"durationSec" <= 180 AND "bytes" <= 5242880/.test(src("prisma/migrations/20261023_demo_chat_journeys/migration.sql")));
}

// ── 5. Security review fixes ──────────────────────────────────────────────────
console.log("\n5. Security review: local cleanup, hard body limit, ffprobe, R2, residual audio risk");
{
  const { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const S = await import("../src/lib/demoChatStorage.js");
  const U = await import("../src/lib/demoChatUpload.js");
  const root = await mkdtemp(`${tmpdir()}/demochat-cleanup-`);
  const up = `${root}/public/uploads`;
  await mkdir(`${up}/demo/chat/images`, { recursive: true }); await mkdir(`${up}/demo/chat/audio`, { recursive: true }); await mkdir(`${up}/products`, { recursive: true });
  const id = "0b6f6c1e-1111-4222-8333-444455556666", id2 = "1c7f7d2f-2222-4333-9444-555566667777";
  await writeFile(`${up}/demo/chat/images/${id}.webp`, "img"); await writeFile(`${up}/demo/chat/audio/${id}.mp3`, "aud");
  await writeFile(`${up}/products/${id}.webp`, "PRODUCT"); await writeFile(`${up}/demo/chat/images/keep.webp`, "keep");
  const exists = (p) => stat(p).then(() => true, () => false);

  ok("owned local image deleted", (await S.destroyDemoChatLocalFile(`/uploads/demo/chat/images/${id}.webp`, { root })).ok && !(await exists(`${up}/demo/chat/images/${id}.webp`)));
  ok("owned local voice note deleted", (await S.destroyDemoChatLocalFile(`/uploads/demo/chat/audio/${id}.mp3`, { root })).ok && !(await exists(`${up}/demo/chat/audio/${id}.mp3`)));
  ok("already gone → ok (idempotent)", (await S.destroyDemoChatLocalFile(`/uploads/demo/chat/audio/${id}.mp3`, { root })).result === "not found");
  const refused = [
    `/uploads/products/${id}.webp`, `/uploads/demo/chat/images/../../../products/${id}.webp`, `/uploads/demo/chat/images/%2e%2e/${id}.webp`,
    "/uploads/demo/chat/images/keep.webp", `/uploads/demo/chat/images/${id}.mp3`, `/uploads/demo/chat/audio/${id}.webp`,
    `/uploads/demo/chat/images/${id}.webp?x=1`, `https://evil.test/uploads/demo/chat/images/${id}.webp`, `/uploads/demo/avatars/${id}.webp`,
    `/uploads/demo/chat/images/${id.toUpperCase()}.webp`, `/uploads/demo/chat/images/${id}.webp/`, "",
  ];
  const results = await Promise.all(refused.map((u) => S.destroyDemoChatLocalFile(u, { root })));
  ok(`${refused.length} non-owned / malformed / traversal URLs refused, nothing touched`, results.every((r) => r.skipped) && (await readFile(`${up}/products/${id}.webp`, "utf8")) === "PRODUCT" && (await exists(`${up}/demo/chat/images/keep.webp`)));
  await symlink(`${up}/products/${id}.webp`, `${up}/demo/chat/images/${id2}.webp`);
  const sym = await S.destroyDemoChatLocalFile(`/uploads/demo/chat/images/${id2}.webp`, { root });
  ok("symlink planted in the demo folder → refused, target untouched", sym.reason === "symlink" && (await readFile(`${up}/products/${id}.webp`, "utf8")) === "PRODUCT");
  const root2 = await mkdtemp(`${tmpdir()}/demochat-escape-`);
  await mkdir(`${root2}/public/uploads/demo/chat`, { recursive: true }); await mkdir(`${root2}/outside`, { recursive: true });
  await writeFile(`${root2}/outside/${id}.webp`, "OUTSIDE");
  await symlink(`${root2}/outside`, `${root2}/public/uploads/demo/chat/images`);
  const esc = await S.destroyDemoChatLocalFile(`/uploads/demo/chat/images/${id}.webp`, { root: root2 });
  ok("symlinked demo folder pointing outside uploads → refused", esc.reason === "path-escape" && (await readFile(`${root2}/outside/${id}.webp`, "utf8")) === "OUTSIDE");
  ok("dispatcher: non-owned URLs go to the shared destroyByUrl (local /uploads skipped as before)", (await S.destroyDemoChatMedia(`/uploads/products/${id}.webp`)).reason === "local-url" && (await readFile(`${up}/products/${id}.webp`, "utf8")) === "PRODUCT");
  ok("service default storage uses the demo-chat dispatcher (global destroyByUrl unchanged)", /destroy: destroyDemoChatMedia/.test(src("src/lib/services/demoChatService.js")) && !/demo\/chat/.test(src("src/lib/cloudinary.js")));

  // Local-mode lifecycle: compensation and delete really remove the files now.
  const db2 = makeDb(); demo.__setDemoDb(db2); svc.__setDemoChatAudioDeps(NO_PROBE);
  const localSave = async (buffer, opts) => { await mkdir(`${up}/${opts.subdir}`, { recursive: true }); await writeFile(`${up}/${opts.subdir}/${opts.filename}`, buffer); return { storage: "local", url: `/uploads/${opts.subdir}/${opts.filename}`, filename: opts.filename }; };
  svc.__setDemoChatStorage({ save: localSave, destroy: (u) => S.destroyDemoChatLocalFile(u, { root }) });
  db2._fx.failAssetCreate = true;
  await quiet(() => rejects(() => svc.uploadAsset("image", PNG, ctx())));
  db2._fx.failAssetCreate = false;
  const { readdir } = await import("node:fs/promises");
  const leftover = (await readdir(`${up}/demo/chat/images`)).filter((f) => f !== "keep.webp" && f !== `${id2}.webp`);
  ok("local mode: failed DB write leaves no orphan file", leftover.length === 0);
  const la = await svc.uploadAsset("audio", mp3(8), ctx());
  ok("local mode: stored under /uploads/demo/chat/audio/<uuid>.m4a", S.parseDemoChatLocalUrl(la.asset.url)?.sub === "audio" && (await exists(`${root}/public${la.asset.url}`)));
  await svc.deleteAsset(la.asset.id, ctx());
  ok("local mode: deleting the asset removes its file", !(await exists(`${root}/public${la.asset.url}`)));
  svc.__setDemoChatStorage(null); svc.__setDemoChatAudioDeps(null);
  await rm(root, { recursive: true, force: true }); await rm(root2, { recursive: true, force: true });

  // Hard body limit (no / false Content-Length).
  const boundary = "----demochat";
  const multipart = (size) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`), Buffer.alloc(size, 1), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const streamReq = (body, headers = {}) => {
    let pulled = 0; const chunk = 64 * 1024;
    const stream = new ReadableStream({ pull(c) { if (pulled >= body.length) { c.close(); return; } c.enqueue(new Uint8Array(body.subarray(pulled, pulled + chunk))); pulled += chunk; } }, { highWaterMark: 0 }); // no eager pre-fill: count only what the reader asks for
    // Stub with a real Headers object: the fetch Request constructor drops a manual Content-Length,
    // while Next.js/Node requests carry the client's value — which is what we need to test.
    const req = { headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}`, ...headers }), body: stream };
    return { req, pulled: () => pulled };
  };
  const small = streamReq(multipart(1000));
  const form = await U.readFormDataWithLimit(small.req, 1024 * 1024);
  ok("within limit: multipart parsed (kind + file)", form.get("kind") === "image" && form.get("file").size === 1000);
  const huge = streamReq(multipart(50 * 1024 * 1024));
  const e1 = await rejects(() => U.readFormDataWithLimit(huge.req, 2 * 1024 * 1024));
  ok(`no Content-Length, 50 MB body → 413 after reading only ~${Math.round(huge.pulled() / 1024)} KB`, e1?.status === 413 && huge.pulled() <= 2 * 1024 * 1024 + 128 * 1024);
  const lying = streamReq(multipart(10 * 1024 * 1024), { "content-length": "1000" });
  const e2 = await rejects(() => U.readFormDataWithLimit(lying.req, 2 * 1024 * 1024));
  ok("understated Content-Length still capped by the byte counter → 413", e2?.status === 413 && lying.pulled() <= 2 * 1024 * 1024 + 128 * 1024);
  const declared = streamReq(multipart(100), { "content-length": String(20 * 1024 * 1024) });
  const e3 = await rejects(() => U.readFormDataWithLimit(declared.req, 2 * 1024 * 1024));
  ok("declared Content-Length over the limit → 413 without reading", e3?.status === 413 && declared.pulled() === 0);
  ok("non-multipart body → 400", (await rejects(() => U.readFormDataWithLimit(new Request("http://x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), 1000)))?.status === 400);

  // ffprobe hardening.
  const args = M.buildProbeArgs("m4a", "/tmp/demo-chat-audio-x.bin");
  ok("ffprobe argv: forced demuxer + file-only protocol, path last, no shell", args.join(" ") === "-v error -protocol_whitelist file -f mov -show_format -show_streams -of json /tmp/demo-chat-audio-x.bin"
    && M.buildProbeArgs("mp3", "f").includes("mp3") && M.buildProbeArgs("ogg", "f").includes("ogg") && (await rejects(() => M.buildProbeArgs("wav", "f"))) !== null);
  const media = src("src/lib/demoChatMedia.js");
  ok("ffprobe runs async (execFile, SIGKILL, 10 s), temp file 0600 exclusive, ≤ 2 concurrent", !/spawnSync|writeFileSync/.test(media) && /killSignal: 'SIGKILL'/.test(media)
    && M.PROBE_TIMEOUT_MS === 10000 && M.PROBE_MAX_CONCURRENT === 2 && /mode: 0o600, flag: 'wx'/.test(media));
  let seenFormat = null;
  const seenFormats = [];
  await M.processVoiceNote(ogg(5), { transcoder: MOCK_TX, probeAvailable: async () => true, runProbe: async (buf, fmt) => { seenFormats.push(fmt); return { format: fmt, durationSec: 5, audioStreams: 1, videoStreams: 0 }; } });
  seenFormat = seenFormats.join(",");
  ok("runProbe receives the detected format for the input, then m4a for the transcoded output", seenFormat === "ogg,m4a");
  let ticks = 0; const iv = setInterval(() => ticks++, 1);
  await M.processVoiceNote(mp3(5), { transcoder: MOCK_TX, probeAvailable: async () => true, runProbe: (b, fmt) => new Promise((r) => setTimeout(() => r({ format: fmt, durationSec: 5, audioStreams: 1, videoStreams: 0 }), 40)) });
  clearInterval(iv);
  ok("a slow probe does not block the event loop", ticks >= 5);

  // R2 content-type and keys.
  const calls = [];
  const deps = { putObject: async (o) => { calls.push(o); }, deleteObject: async () => {} };
  const ENV = { R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b", R2_ENDPOINT: "https://e", R2_PUBLIC_URL: "https://media.test", R2_PREFIX: "siteA" };
  const r2o = await R2.saveMediaR2(Buffer.from("x"), { filename: `${id}.ogg`, category: "demo-chat-audio", resourceType: "video", deterministic: true, contentType: "audio/ogg" }, deps, ENV);
  ok("R2: explicit audio/ogg wins over the .ogg → video/ogg extension default", calls[0].contentType === "audio/ogg" && R2.contentTypeFor("x.ogg") === "video/ogg");
  ok("R2: key = <prefix>/demo-chat-audio/<uuid>.ogg, immutable cache header, URL under the public host", calls[0].key === `siteA/demo-chat-audio/${id}.ogg` && /immutable/.test(calls[0].cacheControl) && r2o.url === `https://media.test/siteA/demo-chat-audio/${id}.ogg`);
  ok("R2 delete only within R2_PREFIX on the R2 host", (await R2.destroyByUrlR2("https://media.test/otherSite/demo-chat-audio/x.ogg", deps, ENV)).reason === "invalid-key" && (await R2.destroyByUrlR2("https://evil.test/siteA/x.ogg", deps, ENV)).reason === "wrong-host");

  // Residual risk, asserted honestly: structure parses ≠ content is safe.
  const len = Math.floor((144 * 32000) / 44100); const frames = [];
  for (let i = 0; i < 300; i++) { const f = Buffer.alloc(len); f.writeUInt32BE((0xfffb0000 | (1 << 12) | (3 << 6)) >>> 0, 0); f.write("<script>alert(1)</script>", 8); frames.push(f); }
  const smuggledInput = Buffer.concat(frames);
  ok("input with bytes hidden in MP3 frames still PARSES (why transcoding is mandatory)", M.parseMp3(smuggledInput).format === "mp3" && smuggledInput.includes(Buffer.from("<script>")));
  const smuggled = await M.processVoiceNote(smuggledInput, NO_PROBE);
  ok("…but only the transcoded output is returned for storage (never the uploaded bytes)", !smuggled.buffer.includes(Buffer.from("<script>")) && smuggled.buffer.toString("latin1", 4, 8) === "ftyp");
}

// ── 6. Transcoding (fake ffmpeg executables + the real ffmpeg if present) ─────
console.log("\n6. Voice-note transcoding");
let skipped = 0;
{
  const T = await import("../src/lib/demoChatTranscode.js");
  const { mkdtemp, writeFile, readFile, readdir, rm, chmod, mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const base = await mkdtemp(`${tmpdir()}/demochat-tx-test-`);
  const tmpRoot = `${base}/tmp`; await mkdir(tmpRoot);
  const fixture = `${base}/fixture.m4a`; await writeFile(fixture, m4a(4));
  let n = 0;
  // A fake "ffmpeg": answers -version / -encoders like ffmpeg, then runs `body` for a transcode.
  const fake = async (body, { version = "ffmpeg version 9.9-fake", encoders = " A....D aac                  AAC (Advanced Audio Coding)" } = {}) => {
    const file = `${base}/ffmpeg-${++n}`;
    await writeFile(file, `#!/bin/sh\necho "$@" >> "${base}/calls-${n}.log"\ncase "$2" in\n  -version) echo "${version}"; exit 0;;\n  -encoders) echo "${encoders}"; exit 0;;\nesac\nfor last; do :; done\ninp=""; prev=""; for a; do [ "$prev" = "-i" ] && inp="$a"; prev="$a"; done\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  const tx = (bin, opts = {}) => T.createFfmpegTranscoder({ env: { FFMPEG_PATH: bin }, tmpRoot, timeoutMs: 3000, ...opts });
  const tmpEmpty = async () => (await readdir(tmpRoot)).length === 0;
  const deps = (transcoder) => ({ probeAvailable: () => false, transcoder });

  const argv = T.buildTranscodeArgs("mp3", "/t/in.mp3", "/t/out.m4a");
  ok("argv: forced demuxer, file-only protocol, strict decode, first audio stream only, metadata dropped, 180 s cap, size cap, AAC mono 44.1 kHz 64k, output last",
    argv.join(" ").includes("-xerror -err_detect explode -protocol_whitelist file -f mp3 -i /t/in.mp3 -map 0:a:0 -vn -sn -dn -map_metadata -1 -map_chapters -1 -t 180")
    && argv.join(" ").includes("-ac 1 -ar 44100 -c:a aac -b:a 64k -threads 1") && argv.includes("-nostdin") && argv.at(-1) === "/t/out.m4a"
    && argv[argv.indexOf("-fs") + 1] === String(T.TRANSCODE_OUTPUT_MAX_BYTES) && T.buildTranscodeArgs("m4a", "a", "b").includes("mov"));
  ok("argv rejects anything but mp3 / ogg / m4a input", (() => { try { T.buildTranscodeArgs("wav", "a", "b"); return false; } catch { return true; } })());

  // Executable verification (explicit, absolute, really ffmpeg, has aac).
  const good = await fake(`cp "${fixture}" "$last"`);
  const notExec = `${base}/not-exec`; await writeFile(notExec, "#!/bin/sh\necho ffmpeg version 1\n"); await chmod(notExec, 0o644);
  ok("FFMPEG_PATH unset → unavailable", !(await T.createFfmpegTranscoder({ env: {}, tmpRoot }).available()));
  ok("relative FFMPEG_PATH (PATH lookup) → unavailable", !(await tx("ffmpeg").available()));
  ok("missing file → unavailable", !(await tx(`${base}/nope`).available()));
  ok("non-executable file → unavailable", !(await tx(notExec).available()));
  ok("executable that is not ffmpeg → unavailable", !(await tx(await fake("exit 0", { version: "Totally Not FFmpeg 1.0" })).available()));
  ok("ffmpeg without the aac encoder → unavailable", !(await tx(await fake("exit 0", { encoders: " A....D libopus  Opus" })).available()));
  const goodTx = tx(good);
  ok("verified ffmpeg → available; verification cached (one -version call)", (await goodTx.available()) && (await goodTx.available()) && (await readFile(`${base}/calls-1.log`, "utf8")).split("\n").filter((l) => l.includes("-version")).length === 1);

  // Missing ffmpeg end to end: fail closed, nothing transcoded, original never returned.
  const missing = await rejects(() => M.processVoiceNote(mp3(5), deps(T.createFfmpegTranscoder({ env: {}, tmpRoot }))));
  ok("no ffmpeg → 503 TRANSCODER_UNAVAILABLE (no fallback to the original)", missing?.code === "TRANSCODER_UNAVAILABLE" && missing.status === 503);
  const neverCalled = { available: async () => false, transcode: async () => { throw new Error("must not be called"); } };
  ok("unavailable transcoder is never invoked", (await rejects(() => M.processVoiceNote(mp3(5), deps(neverCalled))))?.code === "TRANSCODER_UNAVAILABLE");

  // Successful transcode through the real runner (fake binary) + temp-file hygiene.
  const permsBin = await fake(`stat -c '%a' "$inp" > "${base}/perms.log"; stat -c '%a' "$(dirname "$inp")" >> "${base}/perms.log"; cp "${fixture}" "$last"`);
  const okRes = await M.processVoiceNote(mp3(4), deps(tx(permsBin)));
  ok("success: output re-validated as m4a/aac, duration from the OUTPUT", okRes.format === "m4a" && okRes.codec === "aac" && Math.abs(okRes.durationSec - 4) < 0.05 && okRes.validator === "js+ffmpeg");
  ok("input written 0600 inside a private 0700 temp dir", (await readFile(`${base}/perms.log`, "utf8")).trim().split("\n").join(",") === "600,700");
  ok("temp dir removed after success", await tmpEmpty());

  // Failure modes.
  const failRes = await quiet(() => rejects(async () => M.processVoiceNote(mp3(4), deps(tx(await fake(`echo "Invalid data found when processing input" >&2; exit 1`))))));
  ok("ffmpeg error (malformed input) → 422 TRANSCODE_FAILED, stderr not exposed", failRes.result?.code === "TRANSCODE_FAILED" && failRes.result.status === 422 && !/Invalid data/.test(failRes.result.message));
  ok("temp dir removed after failure", await tmpEmpty());
  const t0 = Date.now();
  const slow = await rejects(async () => M.processVoiceNote(mp3(4), deps(tx(await fake("exec sleep 10"), { timeoutMs: 300 }))));
  ok(`hang → killed after the timeout: TRANSCODE_TIMEOUT in ${Date.now() - t0} ms`, slow?.code === "TRANSCODE_TIMEOUT" && Date.now() - t0 < 3000);
  ok("temp dir removed after timeout", await tmpEmpty());
  ok("output reaching the size cap (truncated by -fs) → OUTPUT_TOO_LARGE",
    (await rejects(async () => M.processVoiceNote(mp3(4), deps(tx(await fake(`head -c 4096 /dev/zero > "$last"`), { outputMaxBytes: 4096 })))))?.code === "OUTPUT_TOO_LARGE");
  ok("empty output → TRANSCODE_FAILED", (await rejects(async () => M.processVoiceNote(mp3(4), deps(tx(await fake(`: > "$last"`))))))?.code === "TRANSCODE_FAILED");
  ok("no output file → TRANSCODE_FAILED", (await rejects(async () => M.processVoiceNote(mp3(4), deps(tx(await fake("exit 0"))))))?.code === "TRANSCODE_FAILED");
  ok("transcoder refuses oversized / unsupported / empty input before spawning",
    (await rejects(() => goodTx.transcode(Buffer.alloc(V.AUDIO_MAX_BYTES + 1), { format: "mp3" })))?.code === "FILE_TOO_LARGE"
    && (await rejects(() => goodTx.transcode(Buffer.from("x"), { format: "wav" })))?.code === "UNSUPPORTED_AUDIO"
    && (await rejects(() => goodTx.transcode(Buffer.alloc(0), { format: "mp3" })))?.code === "EMPTY_FILE" && goodTx.stats().runs === 0);
  ok("temp dir empty after all failure modes", await tmpEmpty());

  // Output re-validation (mocked transcoder outputs).
  const out = (buf) => deps({ available: async () => true, transcode: async () => buf });
  ok("output longer than 180 s → TOO_LONG", (await rejects(() => M.processVoiceNote(mp3(179), out(m4a(181)))))?.code === "TOO_LONG");
  ok("output duration inconsistent with the upload → TRANSCODE_FAILED", (await rejects(() => M.processVoiceNote(mp3(10), out(m4a(30)))))?.code === "TRANSCODE_FAILED");
  ok("output that is still the original MP3 → TRANSCODE_FAILED (never stored as-is)", (await rejects(() => M.processVoiceNote(mp3(10), out(mp3(10)))))?.code === "TRANSCODE_FAILED");
  ok("output M4A with a non-AAC codec → TRANSCODE_FAILED", (await rejects(() => M.processVoiceNote(mp3(10), out(m4a(10, { codec: "alac" })))))?.code === "TRANSCODE_FAILED");
  ok("output M4A with a video track → TRANSCODE_FAILED", (await rejects(() => M.processVoiceNote(mp3(10), out(m4a(10, { video: true })))))?.code === "TRANSCODE_FAILED");
  ok("output ≥ 3 MB → OUTPUT_TOO_LARGE", (await rejects(() => M.processVoiceNote(mp3(10), out(Buffer.concat([m4a(10), Buffer.alloc(T.TRANSCODE_OUTPUT_MAX_BYTES)])))))?.code === "OUTPUT_TOO_LARGE");
  ok("transcoder throwing an unexpected error → TRANSCODE_FAILED", (await rejects(() => M.processVoiceNote(mp3(10), deps({ available: async () => true, transcode: async () => { throw new Error("boom"); } }))))?.code === "TRANSCODE_FAILED");

  // Service: a failed transcode stores nothing.
  const db3 = makeDb(); demo.__setDemoDb(db3); const st3 = makeStorage(); svc.__setDemoChatStorage(st3.api);
  svc.__setDemoChatAudioDeps(deps({ available: async () => true, transcode: async () => { throw Object.assign(new Error("x"), { mediaError: true, code: "TRANSCODE_FAILED", status: 422 }); } }));
  const sf = await rejects(() => svc.uploadAsset("audio", mp3(6), ctx()));
  ok("service: transcode failure → 422, nothing stored, no row", sf?.status === 422 && st3.saved.length === 0 && db3._t.demoChatAsset.length === 0);
  svc.__setDemoChatAudioDeps(deps(T.createFfmpegTranscoder({ env: {}, tmpRoot })));
  const su = await rejects(() => svc.uploadAsset("audio", mp3(6), ctx()));
  ok("service: no ffmpeg → 503, nothing stored", su?.status === 503 && su.code === "TRANSCODER_UNAVAILABLE" && st3.saved.length === 0);
  svc.__setDemoChatStorage(null); svc.__setDemoChatAudioDeps(null);

  // Bounded concurrency and queue.
  const slowOk = await fake(`sleep 0.25; cp "${fixture}" "$last"`);
  const cTx = tx(slowOk, { maxConcurrent: 2, maxQueue: 8 });
  const all = await Promise.allSettled(Array.from({ length: 6 }, () => M.processVoiceNote(mp3(4), deps(cTx))));
  ok(`6 concurrent uploads → all transcoded, never more than 2 ffmpeg at once (peak ${cTx.stats().peak})`, all.every((r) => r.status === "fulfilled") && cTx.stats().peak === 2 && cTx.stats().runs === 6);
  const qTx = tx(slowOk, { maxConcurrent: 1, maxQueue: 1 });
  const burst = await Promise.allSettled(Array.from({ length: 4 }, () => M.processVoiceNote(mp3(4), deps(qTx))));
  const busy = burst.filter((r) => r.status === "rejected" && r.reason.code === "TRANSCODER_BUSY");
  ok("queue bounded: excess requests fail fast with 503 TRANSCODER_BUSY", burst.filter((r) => r.status === "fulfilled").length === 2 && busy.length === 2 && busy[0].reason.status === 503 && qTx.stats().peak === 1);
  ok("temp dir empty after concurrent runs", await tmpEmpty());

  // The real ffmpeg (only if present in this environment).
  const REAL = "/usr/bin/ffmpeg";
  if (existsSync(REAL)) {
    const { execFileSync } = await import("node:child_process");
    const gen = (args, file) => { execFileSync(REAL, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", ...args, file]); return readFileSync(file); };
    const realTx = T.createFfmpegTranscoder({ env: { FFMPEG_PATH: REAL }, tmpRoot });
    const inputs = [["mp3", gen(["-ac", "1", "-b:a", "64k"], `${base}/r.mp3`)], ["m4a", gen(["-ac", "1", "-c:a", "aac"], `${base}/r.m4a`)], ["ogg/opus", gen(["-ac", "1", "-c:a", "libopus"], `${base}/r.ogg`)]];
    for (const [label, buf] of inputs) {
      const r = await M.processVoiceNote(buf, deps(realTx));
      ok(`real ffmpeg: ${label} 6 s → canonical m4a/aac ${r.durationSec}s (${r.bytes} B), not the original bytes`, r.format === "m4a" && r.codec === "aac" && Math.abs(r.durationSec - 6) < 0.1 && !r.buffer.equals(buf) && r.mimeType === "audio/mp4");
    }
    const realSmuggle = await M.processVoiceNote(smuggleMp3(), deps(realTx));
    ok("real ffmpeg: payload hidden in MP3 frames does not survive the re-encode", !realSmuggle.buffer.includes(Buffer.from("<script>")) && realSmuggle.codec === "aac");
    const meta = gen(["-ac", "1", "-b:a", "64k", "-metadata", "title=SECRET-TITLE", "-metadata", "artist=SECRET-ARTIST"], `${base}/meta.mp3`);
    const rm2 = await M.processVoiceNote(meta, deps(realTx));
    ok("real ffmpeg: tags dropped and no encoder string in the output", !rm2.buffer.includes(Buffer.from("SECRET")) && !rm2.buffer.includes(Buffer.from("Lavf")));
    ok("real ffmpeg: corrupted input → TRANSCODE_FAILED or INVALID_AUDIO, never stored",
      ["TRANSCODE_FAILED", "INVALID_AUDIO"].includes((await quiet(() => rejects(() => M.processVoiceNote(Buffer.concat([inputs[0][1].subarray(0, 4000), Buffer.alloc(3000, 0xff), inputs[0][1].subarray(7000)]), deps(realTx))))).result?.code));
    ok("real ffmpeg: temp dir empty afterwards", await tmpEmpty());
  } else { skipped++; console.log("  SKIP  real ffmpeg path (no /usr/bin/ffmpeg in this environment)"); }
  await rm(base, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail ? 1 : 0);
