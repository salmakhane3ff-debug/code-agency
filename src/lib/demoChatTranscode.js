/**
 * src/lib/demoChatTranscode.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side voice-note TRANSCODING for the DEMO chat (Phase 3C-3). SERVER-ONLY.
 *
 * Structure checks prove a voice note parses — not that its bytes are benign
 * (arbitrary data can hide inside frames/packets and survive a decode). Every
 * accepted voice note is therefore re-encoded and ONLY the re-encoded output
 * is ever stored. The original upload is never stored, and there is no
 * fallback: if ffmpeg is missing, misconfigured, slow or fails, the upload is
 * rejected.
 *
 * Canonical output: AAC-LC in MP4 (.m4a, audio/mp4), mono, 44.1 kHz, 64 kb/s,
 * `+faststart`, all metadata/chapters/extra streams dropped, bitexact (no
 * encoder string). Plays in every current browser, incl. iOS Safari.
 *
 * Execution safety
 *   • Executable: FFMPEG_PATH must be an ABSOLUTE path to an executable file
 *     whose `-version` output starts with "ffmpeg version" and which provides
 *     the native `aac` encoder. No PATH lookup, verified once per path.
 *   • execFile with a fixed argv (no shell); the only variable parts are paths
 *     inside a private temp dir. Input demuxer forced (`-f mp3|ogg|mov`), only
 *     the `file` protocol, `-xerror -err_detect explode` (any decode error
 *     fails), `-nostdin`, one thread, `-t 180` hard cap, `-fs` output cap.
 *   • Hard timeout (SIGKILL), bounded concurrency + bounded queue, stderr
 *     capped and never shown to clients.
 *   • Private temp dir (mkdtemp, 0700), files created exclusively (0600),
 *     always removed (also on timeout/failure).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUDIO_MAX_BYTES, AUDIO_MAX_DURATION_SEC } from './demoChatValidation.js';

export const TRANSCODE_TIMEOUT_MS = 30_000;
export const TRANSCODE_MAX_CONCURRENT = 2;
export const TRANSCODE_MAX_QUEUE = 8;
export const TRANSCODE_OUTPUT_MAX_BYTES = 3 * 1024 * 1024; // 180 s @ 64 kb/s ≈ 1.5 MB
export const CANONICAL_AUDIO = Object.freeze({ format: 'm4a', codec: 'aac', mimeType: 'audio/mp4', ext: 'm4a', bitrate: '64k', sampleRate: 44100, channels: 1 });

const DEMUXER = Object.freeze({ mp3: 'mp3', ogg: 'ogg', m4a: 'mov' });
const IN_EXT = Object.freeze({ mp3: 'mp3', ogg: 'ogg', m4a: 'm4a' });

export const transcodeError = (code, message, status) => Object.assign(new Error(message), { code, status, mediaError: true });

/** Fixed ffmpeg argv for one transcode. Pure. */
export function buildTranscodeArgs(format, inPath, outPath, { outputMaxBytes = TRANSCODE_OUTPUT_MAX_BYTES } = {}) {
  const demuxer = DEMUXER[format];
  if (!demuxer) throw new Error('unsupported input format');
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
    '-protocol_whitelist', 'file', '-f', demuxer, '-i', inPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-t', String(AUDIO_MAX_DURATION_SEC),
    '-ac', String(CANONICAL_AUDIO.channels), '-ar', String(CANONICAL_AUDIO.sampleRate),
    '-c:a', 'aac', '-b:a', CANONICAL_AUDIO.bitrate, '-threads', '1',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart',
    '-fs', String(outputMaxBytes), '-f', 'mp4', outPath,
  ];
}

const run = (bin, args, { timeout, maxBuffer = 256 * 1024 }) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, killSignal: 'SIGKILL', maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(err, { stderr: String(stderr || '').slice(0, 2000) }));
    resolve(String(stdout));
  });
});

/**
 * Build a transcoder. Defaults read FFMPEG_PATH from the environment.
 * Returns { available(), transcode(buffer, { format }), stats() }.
 */
export function createFfmpegTranscoder({
  env = process.env, timeoutMs = TRANSCODE_TIMEOUT_MS, maxConcurrent = TRANSCODE_MAX_CONCURRENT,
  maxQueue = TRANSCODE_MAX_QUEUE, outputMaxBytes = TRANSCODE_OUTPUT_MAX_BYTES, tmpRoot = tmpdir(),
} = {}) {
  const verified = new Map(); // path → Promise<boolean>
  let active = 0; let peak = 0; let runs = 0; const queue = [];

  async function verify(bin) {
    if (!bin || typeof bin !== 'string' || !path.isAbsolute(bin)) return false;
    try {
      const st = await stat(bin);
      if (!st.isFile()) return false;
      await access(bin, constants.X_OK);
      const version = await run(bin, ['-hide_banner', '-version'], { timeout: 5000 });
      if (!/^ffmpeg version /.test(version)) return false;
      const encoders = await run(bin, ['-hide_banner', '-encoders'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
      return /^\s*A[.\w]{5}\s+aac\s/m.test(encoders);
    } catch {
      return false;
    }
  }

  function available() {
    const bin = env.FFMPEG_PATH;
    if (!verified.has(bin)) verified.set(bin, verify(bin));
    return verified.get(bin);
  }

  async function slot(fn) {
    while (active >= maxConcurrent) { // re-checked after every wake-up: the cap can never be exceeded
      if (queue.length >= maxQueue) throw transcodeError('TRANSCODER_BUSY', 'Conversion audio saturée : réessayez dans un instant.', 503);
      await new Promise((resolve) => queue.push(resolve));
    }
    active++; peak = Math.max(peak, active);
    try { return await fn(); } finally { active--; const next = queue.shift(); if (next) next(); }
  }

  async function transcode(buffer, { format } = {}) {
    if (!DEMUXER[format]) throw transcodeError('UNSUPPORTED_AUDIO', 'Format audio non pris en charge.', 415);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw transcodeError('EMPTY_FILE', 'Fichier vide.', 400);
    if (buffer.length > AUDIO_MAX_BYTES) throw transcodeError('FILE_TOO_LARGE', 'Note vocale trop lourde (5 Mo max).', 413);
    if (!(await available())) throw transcodeError('TRANSCODER_UNAVAILABLE', 'Conversion audio indisponible sur ce serveur : notes vocales désactivées.', 503);
    return slot(async () => {
      runs++;
      const dir = await mkdtemp(path.join(tmpRoot, 'demo-chat-tx-'));
      try {
        const inPath = path.join(dir, `in.${IN_EXT[format]}`);
        const outPath = path.join(dir, 'out.m4a');
        await writeFile(inPath, buffer, { mode: 0o600, flag: 'wx' });
        try {
          await run(env.FFMPEG_PATH, buildTranscodeArgs(format, inPath, outPath, { outputMaxBytes }), { timeout: timeoutMs });
        } catch (e) {
          if (e?.killed || e?.signal === 'SIGKILL') throw transcodeError('TRANSCODE_TIMEOUT', 'Conversion audio trop longue : fichier refusé.', 422);
          console.warn('[demo-chat transcode] ffmpeg rejected the input:', e?.stderr || e?.message);
          throw transcodeError('TRANSCODE_FAILED', 'Conversion audio impossible : fichier refusé.', 422);
        }
        let out;
        try { out = await readFile(outPath); } catch { throw transcodeError('TRANSCODE_FAILED', 'Conversion audio impossible : fichier refusé.', 422); }
        // `-fs` stops ffmpeg at the cap WITHOUT an error: reaching it means a truncated output.
        if (out.length === 0) throw transcodeError('TRANSCODE_FAILED', 'Conversion audio impossible : fichier refusé.', 422);
        if (out.length >= outputMaxBytes) throw transcodeError('OUTPUT_TOO_LARGE', 'Note vocale convertie trop lourde : fichier refusé.', 413);
        return out;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  return { available, transcode, stats: () => ({ active, peak, queued: queue.length, runs }) };
}

/** Process-wide transcoder (FFMPEG_PATH from the environment). */
export const defaultTranscoder = createFfmpegTranscoder();
