/**
 * src/lib/demoChatStorage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deletion of DEMO chat media (Phase 3C-3). SERVER-ONLY.
 *
 * The shared destroyByUrl() (cloudinary.js) deletes R2 / Cloudinary objects but
 * deliberately never deletes local /uploads files. Demo chat assets stored in
 * local mode would then outlive their deletion (or a failed upload) and stay
 * publicly reachable. This module adds a NARROW local cleanup that only ever
 * touches files this feature created:
 *   /uploads/demo/chat/images/<uuid v4>.webp
 *   /uploads/demo/chat/audio/<uuid v4>.(mp3|m4a|ogg)
 * Anything else (other folders, other names, traversal, encoded segments,
 * query strings, symlinks, directories) is refused and left untouched. Every
 * other URL is delegated unchanged to the shared destroyByUrl().
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { destroyByUrl } from './cloudinary.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LOCAL_URL_RE = new RegExp(`^/uploads/demo/chat/(?:(images)/(${UUID})\\.(webp)|(audio)/(${UUID})\\.(mp3|m4a|ogg))$`);

/** { sub, name } for a demo-chat-owned local URL, or null. Pure. */
export function parseDemoChatLocalUrl(url) {
  if (typeof url !== 'string') return null;
  const m = LOCAL_URL_RE.exec(url);
  if (!m) return null;
  return m[1] ? { sub: 'images', name: `${m[2]}.${m[3]}` } : { sub: 'audio', name: `${m[5]}.${m[6]}` };
}

/**
 * Delete one demo-chat-owned local file. Never throws; returns
 * { ok, result|reason }. `root` = project root (tests use a temp dir).
 */
export async function destroyDemoChatLocalFile(url, { root = process.cwd() } = {}) {
  const parsed = parseDemoChatLocalUrl(url);
  if (!parsed) return { ok: false, skipped: true, reason: 'not-demo-chat-local' };
  try {
    const uploads = path.join(root, 'public', 'uploads');
    const dir = path.join(uploads, 'demo', 'chat', parsed.sub);
    const file = path.join(dir, parsed.name);
    if (path.relative(dir, file) !== parsed.name) return { ok: false, skipped: true, reason: 'path-escape' };
    // The folder chain must really live under public/uploads (no symlinked escape).
    let realDir; let realUploads;
    try { [realDir, realUploads] = await Promise.all([realpath(dir), realpath(uploads)]); } catch { return { ok: true, result: 'not found' }; }
    if (realDir !== path.join(realUploads, 'demo', 'chat', parsed.sub)) return { ok: false, skipped: true, reason: 'path-escape' };
    let st;
    try { st = await lstat(file); } catch (e) { if (e?.code === 'ENOENT') return { ok: true, result: 'not found' }; throw e; }
    if (!st.isFile()) return { ok: false, skipped: true, reason: st.isSymbolicLink() ? 'symlink' : 'not-a-file' };
    await unlink(file);
    return { ok: true, storage: 'local', result: 'deleted' };
  } catch (e) {
    return { ok: false, storage: 'local', error: e?.message || String(e) };
  }
}

/** Demo chat deletion dispatcher: owned local files here, everything else unchanged. */
export async function destroyDemoChatMedia(url, opts) {
  if (parseDemoChatLocalUrl(url)) return destroyDemoChatLocalFile(url, opts);
  return destroyByUrl(url);
}
