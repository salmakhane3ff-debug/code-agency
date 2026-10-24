/**
 * src/lib/demoChatMedia.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVER-ONLY validation + normalisation of DEMO chat media (Phase 3C-3), from
 * the ACTUAL bytes — never the filename, extension, client MIME type or a
 * client-reported duration. Pure (no DB, no storage). FAIL-CLOSED: anything
 * that cannot be positively parsed is rejected.
 *
 * Images  — magic bytes must be JPEG / PNG / WEBP; sharp then decodes the file
 *           (pixel limit, single frame, min size) and RE-ENCODES it to WebP
 *           (max 1600 px, q82, EXIF orientation applied). sharp drops all
 *           metadata (EXIF/GPS/ICC/XMP) unless asked to keep it, and the
 *           re-encode discards anything appended to the image (polyglots).
 * Audio   — container detected by structure, then parsed end to end with a
 *           dependency-free parser (same approach as ugcVideoValidation.js):
 *             • MP3   every MPEG audio frame walked (Layer III, consistent
 *                     sample rate) → duration = Σ samples / rate; ID3v2/ID3v1
 *                     tags (incl. cover art) are cut off before transcoding.
 *             • M4A   ISO-BMFF box tree must tile the file; exactly audio
 *                     tracks (hdlr 'soun', stsd 'mp4a'), no video track;
 *                     duration from mvhd.
 *             • OGG   every page checked (capture pattern, CRC-32, one logical
 *                     stream); Opus (OpusHead) or Vorbis; duration from the
 *                     last granule position (Opus: minus pre-skip, 48 kHz).
 *           When ffprobe is installed (FFPROBE_PATH honoured, as in
 *           videoValidation.js) it is run as a SECOND, independent check —
 *           asynchronously (never blocks the event loop), SIGKILL after 10 s,
 *           at most 2 at a time, demuxer FORCED to the detected format and
 *           only the local `file` protocol allowed (no network / no other
 *           files), on a 0600 temp file created exclusively. It
 *           must agree on the format and the duration (±max(1 s, 5 %)), and
 *           the longer of the two durations is checked against the limit.
 *           No duration → rejected.
 *           Then the voice note is TRANSCODED (demoChatTranscode.js) to the
 *           canonical AAC/M4A, and the OUTPUT is re-validated from its bytes
 *           (M4A structure, AAC, duration ≤ 180 s and consistent with the
 *           input, size cap; ffprobe again when available). Only that output
 *           is returned for storage — never the original upload. No ffmpeg or
 *           any failure → rejected (fail-closed, no fallback).
 * ffprobe and the transcoder are injectable (`deps`) for tests.
 *
 * Parsing alone is NOT a safety guarantee (arbitrary bytes can sit inside
 * frames/packets and survive a decode); the re-encode is what normalises the
 * stored bytes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { defaultTranscoder, CANONICAL_AUDIO, TRANSCODE_OUTPUT_MAX_BYTES } from './demoChatTranscode.js';
import {
  IMAGE_MAX_UPLOAD_BYTES, IMAGE_INPUT_FORMATS, AUDIO_MAX_BYTES, AUDIO_MAX_DURATION_SEC, AUDIO_MIN_DURATION_SEC,
} from './demoChatValidation.js';

export const IMAGE_MAX_DIMENSION = 1600;          // px, longest side (imageOptimize.js convention)
export const IMAGE_MIN_DIMENSION = 16;
export const IMAGE_MAX_INPUT_PIXELS = 40_000_000; // decompression-bomb guard
export const IMAGE_WEBP_QUALITY = 82;

export const mediaError = (code, message, status = 415) => Object.assign(new Error(message), { code, status, mediaError: true });

// ── Images ────────────────────────────────────────────────────────────────────

/** Image container from magic bytes only. */
export function sniffImageFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype') || head.startsWith('<html')) return 'markup';
  return null;
}

/**
 * Validate + re-encode an image. Returns
 * { buffer, format: 'webp', inputFormat, mimeType, ext, width, height, bytes }.
 */
export async function processChatImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw mediaError('EMPTY_FILE', 'Fichier vide.', 400);
  if (buffer.length > IMAGE_MAX_UPLOAD_BYTES) throw mediaError('FILE_TOO_LARGE', `Image trop lourde (${IMAGE_MAX_UPLOAD_BYTES / 1024 / 1024} Mo max).`, 413);
  const sniffed = sniffImageFormat(buffer);
  if (!IMAGE_INPUT_FORMATS.includes(sniffed)) throw mediaError('UNSUPPORTED_IMAGE', 'Format non pris en charge : JPG, PNG ou WEBP uniquement (contenu vérifié).');

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS, animated: true }).metadata();
  } catch {
    throw mediaError('INVALID_IMAGE', 'Image illisible ou corrompue.');
  }
  if (meta.format !== sniffed) throw mediaError('INVALID_IMAGE', 'Contenu de l’image incohérent.');
  if ((meta.pages || 1) > 1) throw mediaError('ANIMATED_IMAGE', 'Images animées non acceptées.');
  if (!meta.width || !meta.height || meta.width < IMAGE_MIN_DIMENSION || meta.height < IMAGE_MIN_DIMENSION) {
    throw mediaError('IMAGE_TOO_SMALL', `Image trop petite (${IMAGE_MIN_DIMENSION} px minimum).`);
  }
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, format: 'webp', inputFormat: sniffed, mimeType: 'image/webp', ext: 'webp', width: info.width, height: info.height, bytes: data.length };
  } catch {
    throw mediaError('INVALID_IMAGE', 'Image illisible ou corrompue.');
  }
}

// ── Audio: format detection ───────────────────────────────────────────────────

export function sniffAudioFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

// ── MP3 ───────────────────────────────────────────────────────────────────────

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],      // MPEG-2/2.5 Layer III
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Frame(buf, off) {
  if (off + 4 > buf.length) return null;
  const h = buf.readUInt32BE(off);
  if ((h >>> 21) !== 0x7ff) return null;
  const version = (h >>> 19) & 3;     // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 reserved
  const layer = (h >>> 17) & 3;       // 1 = Layer III
  const brIdx = (h >>> 12) & 15;
  const srIdx = (h >>> 10) & 3;
  const pad = (h >>> 9) & 1;
  if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const bitrate = MP3_BITRATES[version === 3 ? 1 : 2][brIdx] * 1000;
  const rate = MP3_RATES[version][srIdx];
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / rate) + pad;
  return { version, rate, samples, length };
}

function id3v2Size(buf) {
  if (buf.toString('ascii', 0, 3) !== 'ID3' || buf.length < 10) return 0;
  if ([6, 7, 8, 9].some((i) => buf[i] & 0x80)) return -1; // sizes are syncsafe
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  return 10 + size + (buf[5] & 0x10 ? 10 : 0);
}

export function parseMp3(buf) {
  const start = id3v2Size(buf);
  if (start < 0 || start >= buf.length) return { error: 'en-tête ID3 invalide' };
  let off = start; let frames = 0; let samples = 0; let rate = null; let version = null; let first = true;
  while (off < buf.length) {
    const f = mp3Frame(buf, off);
    if (!f) break;
    if (f.length < 24 || off + f.length > buf.length) return { error: 'trame MP3 tronquée' };
    if (rate === null) { rate = f.rate; version = f.version; }
    if (f.rate !== rate || f.version !== version) return { error: 'trames MP3 incohérentes' };
    // A leading Xing/Info/VBRI frame carries no audio.
    const tag = buf.subarray(off + 4, off + Math.min(f.length, 64)).toString('latin1');
    if (!(first && /Xing|Info|VBRI/.test(tag))) { samples += f.samples; frames++; }
    first = false;
    off += f.length;
  }
  const trailing = buf.length - off;
  if (frames < 2) return { error: 'aucune trame audio MP3 valide' };
  if (trailing > 0 && !(trailing === 128 && buf.toString('ascii', off, off + 3) === 'TAG')) return { error: 'données inattendues après l’audio' };
  return { format: 'mp3', codec: 'mp3', durationSec: samples / rate, sampleRate: rate, output: buf.subarray(start, off) };
}

// ── M4A (ISO-BMFF) ────────────────────────────────────────────────────────────

const BMFF_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);

function bmffBoxes(buf, start, end) {
  const boxes = []; let off = start;
  while (off < end) {
    if (off + 8 > end) return null;
    let size = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8); let header = 8;
    if (size === 1) { if (off + 16 > end) return null; const hi = buf.readUInt32BE(off + 8); if (hi) return null; size = buf.readUInt32BE(off + 12); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) return null;
    boxes.push({ type, start: off, body: off + header, end: off + size });
    off += size;
  }
  return boxes;
}

export function parseM4a(buf) {
  const top = bmffBoxes(buf, 0, buf.length);
  if (!top || top[0]?.type !== 'ftyp') return { error: 'structure MP4 invalide' };
  const moov = top.filter((b) => b.type === 'moov');
  if (moov.length !== 1 || !top.some((b) => b.type === 'mdat')) return { error: 'boîtes moov/mdat manquantes' };
  if (top.some((b) => b.type === 'moof')) return { error: 'MP4 fragmenté non pris en charge' };
  const find = (box, type) => (bmffBoxes(buf, box.body, box.end) || []).filter((b) => b.type === type);
  const walkOk = (box) => { const kids = bmffBoxes(buf, box.body, box.end); return kids && kids.every((k) => !BMFF_CONTAINERS.has(k.type) || walkOk(k)); };
  if (!walkOk(moov[0])) return { error: 'arborescence MP4 corrompue' };
  const mvhd = find(moov[0], 'mvhd')[0];
  if (!mvhd || mvhd.end - mvhd.body < 20) return { error: 'mvhd manquant' };
  const v = buf[mvhd.body];
  let timescale; let duration;
  if (v === 1) { if (mvhd.end - mvhd.body < 32) return { error: 'mvhd tronqué' }; timescale = buf.readUInt32BE(mvhd.body + 20); duration = buf.readUInt32BE(mvhd.body + 24) * 2 ** 32 + buf.readUInt32BE(mvhd.body + 28); }
  else { timescale = buf.readUInt32BE(mvhd.body + 12); duration = buf.readUInt32BE(mvhd.body + 16); }
  if (!timescale || !duration || duration === 0xffffffff) return { error: 'durée MP4 indéterminée' };
  let audio = 0; let video = 0; let codec = null;
  for (const trak of find(moov[0], 'trak')) {
    const mdia = find(trak, 'mdia')[0]; if (!mdia) return { error: 'piste MP4 invalide' };
    const hdlr = find(mdia, 'hdlr')[0]; if (!hdlr || hdlr.end - hdlr.body < 12) return { error: 'hdlr manquant' };
    const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
    if (handler === 'vide') video++;
    if (handler !== 'soun') continue;
    const minf = find(mdia, 'minf')[0];
    const stbl = minf && find(minf, 'stbl')[0];
    const stsd = stbl && find(stbl, 'stsd')[0];
    if (!stsd || stsd.end - stsd.body < 16) return { error: 'stsd manquant' };
    codec = buf.toString('latin1', stsd.body + 12, stsd.body + 16);
    if (codec !== 'mp4a') return { error: `codec audio non pris en charge (${codec})` };
    audio++;
  }
  if (video > 0) return { error: 'le fichier contient une piste vidéo' };
  if (audio === 0) return { error: 'aucune piste audio' };
  return { format: 'm4a', codec: 'aac', durationSec: duration / timescale, output: buf };
}

// ── Ogg (Opus / Vorbis) ───────────────────────────────────────────────────────

const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0; t[i] = r >>> 0; }
  return t;
})();
export function oggCrc(page) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

export function parseOgg(buf) {
  let off = 0; let serial = null; let lastGranule = null; let codec = null; let preSkip = 0; let rate = 0; let pages = 0;
  while (off < buf.length) {
    if (off + 27 > buf.length || buf.toString('ascii', off, off + 4) !== 'OggS' || buf[off + 4] !== 0) return { error: 'page Ogg invalide' };
    const type = buf[off + 5];
    const granule = buf.readBigInt64LE(off + 6);
    const ser = buf.readUInt32LE(off + 14);
    const nseg = buf[off + 26];
    if (off + 27 + nseg > buf.length) return { error: 'page Ogg tronquée' };
    let bodyLen = 0; for (let i = 0; i < nseg; i++) bodyLen += buf[off + 27 + i];
    const end = off + 27 + nseg + bodyLen;
    if (end > buf.length) return { error: 'page Ogg tronquée' };
    if (oggCrc(buf.subarray(off, end)) !== buf.readUInt32LE(off + 22)) return { error: 'somme de contrôle Ogg invalide' };
    if (serial === null) {
      if (!(type & 2)) return { error: 'début de flux Ogg manquant' };
      serial = ser;
      const body = buf.subarray(off + 27 + nseg, end);
      if (body.length >= 19 && body.toString('ascii', 0, 8) === 'OpusHead') {
        if (body[8] !== 1 || body[9] < 1 || body[9] > 2) return { error: 'en-tête Opus invalide' };
        codec = 'opus'; preSkip = body.readUInt16LE(10); rate = 48000;
      } else if (body.length >= 30 && body[0] === 1 && body.toString('ascii', 1, 7) === 'vorbis') {
        codec = 'vorbis'; rate = body.readUInt32LE(12);
        if (!rate) return { error: 'en-tête Vorbis invalide' };
      } else return { error: 'codec Ogg non pris en charge (Opus ou Vorbis uniquement)' };
    } else if (ser !== serial) return { error: 'plusieurs flux Ogg multiplexés' };
    if (granule !== -1n) lastGranule = granule;
    pages++; off = end;
  }
  if (!codec || pages < 2 || lastGranule === null) return { error: 'flux Ogg incomplet' };
  const samples = Number(lastGranule) - (codec === 'opus' ? preSkip : 0);
  if (!(samples > 0)) return { error: 'durée Ogg indéterminée' };
  return { format: 'ogg', codec, durationSec: samples / rate, output: buf };
}

// ── ffprobe (optional second opinion) ─────────────────────────────────────────

export function normalizeProbe(json) {
  const fmt = (json && json.format) || {};
  const streams = Array.isArray(json && json.streams) ? json.streams : [];
  const names = String(fmt.format_name || '').toLowerCase().split(',');
  const format = names.includes('mp3') ? 'mp3' : names.includes('ogg') ? 'ogg' : names.some((n) => ['mov', 'mp4', 'm4a'].includes(n)) ? 'm4a' : null;
  return {
    format,
    durationSec: Number(fmt.duration),
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    videoStreams: streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)).length,
  };
}

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_CONCURRENT = 2;
const PROBE_DEMUXER = Object.freeze({ mp3: 'mp3', ogg: 'ogg', m4a: 'mov' });

/** ffprobe argv (no shell): forced demuxer, local-file protocol only. Pure. */
export function buildProbeArgs(format, file) {
  const demuxer = PROBE_DEMUXER[format];
  if (!demuxer) throw new Error('unsupported probe format');
  return ['-v', 'error', '-protocol_whitelist', 'file', '-f', demuxer, '-show_format', '-show_streams', '-of', 'json', file];
}

const run = (bin, args, opts) => new Promise((resolve, reject) => {
  execFile(bin, args, { killSignal: 'SIGKILL', windowsHide: true, ...opts }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

let _probeAvailable = null; // cached for the process lifetime
function defaultProbeAvailable(env = process.env) {
  if (!_probeAvailable) _probeAvailable = run(env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 3000, maxBuffer: 1024 * 1024 }).then(() => true, () => false);
  return _probeAvailable;
}

let _active = 0; const _waiting = [];
async function withProbeSlot(fn) {
  while (_active >= PROBE_MAX_CONCURRENT) await new Promise((r) => _waiting.push(r));
  _active++;
  try { return await fn(); } finally { _active--; const next = _waiting.shift(); if (next) next(); }
}

async function defaultRunProbe(buffer, format, env = process.env) {
  return withProbeSlot(async () => {
    const tmp = join(tmpdir(), `demo-chat-audio-${randomUUID()}.bin`);
    try {
      await writeFile(tmp, buffer, { mode: 0o600, flag: 'wx' });
      const stdout = await run(env.FFPROBE_PATH || 'ffprobe', buildProbeArgs(format, tmp), { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      return normalizeProbe(JSON.parse(String(stdout)));
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
}

const consistent = (a, b) => Math.abs(a - b) <= Math.max(1, Math.max(a, b) * 0.05);

/**
 * Validate, transcode and re-validate a voice note. Returns the CANONICAL
 * output only: { buffer, format: 'm4a', codec: 'aac', mimeType: 'audio/mp4',
 * ext: 'm4a', durationSec, bytes, inputFormat, inputCodec, inputDurationSec,
 * validator }.
 */
export async function processVoiceNote(buffer, deps = {}) {
  const { probeAvailable = defaultProbeAvailable, runProbe = defaultRunProbe, transcoder = defaultTranscoder } = deps;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw mediaError('EMPTY_FILE', 'Fichier vide.', 400);
  if (buffer.length > AUDIO_MAX_BYTES) throw mediaError('FILE_TOO_LARGE', 'Note vocale trop lourde (5 Mo max).', 413);
  const format = sniffAudioFormat(buffer);
  if (!format) throw mediaError('UNSUPPORTED_AUDIO', 'Format audio non pris en charge : MP3, M4A ou OGG uniquement (contenu vérifié).');
  const parsed = format === 'mp3' ? parseMp3(buffer) : format === 'm4a' ? parseM4a(buffer) : parseOgg(buffer);
  if (parsed.error) throw mediaError('INVALID_AUDIO', `Fichier audio invalide : ${parsed.error}.`);
  if (!Number.isFinite(parsed.durationSec) || parsed.durationSec <= 0) throw mediaError('NO_DURATION', 'Durée de la note vocale impossible à déterminer.');

  // 1. Input checks (JS parser, ffprobe as a second opinion when available).
  const hasProbe = await probeAvailable();
  let duration = parsed.durationSec;
  if (hasProbe) {
    let probe;
    try { probe = await runProbe(parsed.output, format); } catch { throw mediaError('INVALID_AUDIO', 'Fichier audio refusé par la vérification ffprobe.'); }
    if (probe.format !== format || probe.audioStreams !== 1 || probe.videoStreams !== 0) throw mediaError('INVALID_AUDIO', 'Contenu audio incohérent (ffprobe).');
    if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0) throw mediaError('NO_DURATION', 'Durée de la note vocale impossible à déterminer.');
    if (!consistent(probe.durationSec, duration)) throw mediaError('INVALID_AUDIO', 'Durées incohérentes entre les vérifications.');
    duration = Math.max(duration, probe.durationSec);
  }
  if (duration > AUDIO_MAX_DURATION_SEC) throw mediaError('TOO_LONG', 'Note vocale trop longue (3 minutes max).', 413);
  if (duration < AUDIO_MIN_DURATION_SEC) throw mediaError('TOO_SHORT', 'Note vocale trop courte.', 400);

  // 2. Transcode — fail closed: no ffmpeg / any failure → rejected, original never kept.
  if (!(await transcoder.available())) throw mediaError('TRANSCODER_UNAVAILABLE', 'Conversion audio indisponible sur ce serveur : notes vocales désactivées.', 503);
  let out;
  try {
    out = await transcoder.transcode(parsed.output, { format, durationSec: duration });
  } catch (e) {
    if (e?.mediaError) throw e;
    throw mediaError('TRANSCODE_FAILED', 'Conversion audio impossible : fichier refusé.', 422);
  }

  // 3. Re-validate the OUTPUT from its bytes.
  if (!Buffer.isBuffer(out) || out.length === 0) throw mediaError('TRANSCODE_FAILED', 'Conversion audio impossible : fichier refusé.', 422);
  if (out.length >= TRANSCODE_OUTPUT_MAX_BYTES) throw mediaError('OUTPUT_TOO_LARGE', 'Note vocale convertie trop lourde : fichier refusé.', 413);
  if (sniffAudioFormat(out) !== 'm4a') throw mediaError('TRANSCODE_FAILED', 'Sortie de conversion invalide.', 422);
  const check = parseM4a(out);
  if (check.error || check.codec !== 'aac') throw mediaError('TRANSCODE_FAILED', 'Sortie de conversion invalide.', 422);
  let outDuration = check.durationSec;
  if (hasProbe) {
    let probe;
    try { probe = await runProbe(out, 'm4a'); } catch { throw mediaError('TRANSCODE_FAILED', 'Sortie de conversion invalide (ffprobe).', 422); }
    if (probe.format !== 'm4a' || probe.audioStreams !== 1 || probe.videoStreams !== 0 || !Number.isFinite(probe.durationSec)) throw mediaError('TRANSCODE_FAILED', 'Sortie de conversion invalide (ffprobe).', 422);
    if (!consistent(probe.durationSec, outDuration)) throw mediaError('TRANSCODE_FAILED', 'Sortie de conversion incohérente.', 422);
    outDuration = Math.max(outDuration, probe.durationSec);
  }
  if (!(outDuration > 0)) throw mediaError('NO_DURATION', 'Durée de la note vocale impossible à déterminer.');
  if (outDuration > AUDIO_MAX_DURATION_SEC) throw mediaError('TOO_LONG', 'Note vocale trop longue (3 minutes max).', 413);
  if (!consistent(outDuration, duration)) throw mediaError('TRANSCODE_FAILED', 'Durée de la sortie incohérente avec le fichier envoyé.', 422);

  return {
    buffer: out, format: CANONICAL_AUDIO.format, codec: CANONICAL_AUDIO.codec, mimeType: CANONICAL_AUDIO.mimeType, ext: CANONICAL_AUDIO.ext,
    durationSec: Math.round(outDuration * 100) / 100, bytes: out.length,
    inputFormat: format, inputCodec: parsed.codec, inputDurationSec: Math.round(duration * 100) / 100,
    validator: hasProbe ? 'js+ffprobe+ffmpeg' : 'js+ffmpeg',
  };
}
