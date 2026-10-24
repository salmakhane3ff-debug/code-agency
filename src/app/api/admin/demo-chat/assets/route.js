/**
 * /api/admin/demo-chat/assets — DEMO chat media library (admin only, Phase 3C-3)
 * GET  ?kind=image|audio → assets with usage counts
 * POST multipart { kind: 'image'|'audio', file } → validated from the actual
 *      bytes (images re-encoded to WebP; voice notes ≤ 5 MB / ≤ 3 min), stored
 *      under a generated key, audited. Identical content returns the existing asset.
 * Simulation media only — never product, affiliate or customer uploads.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { IMAGE_MAX_UPLOAD_BYTES, AUDIO_MAX_BYTES } from '@/lib/demoChatValidation';
import { readFormDataWithLimit, MULTIPART_OVERHEAD } from '@/lib/demoChatUpload';
import { listAssets, uploadAsset } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

const tooLarge = (msg) => Response.json({ error: msg, code: 'FILE_TOO_LARGE', field: 'file' }, { status: 413 });

export const GET = withAdminAuth(async (req) => {
  try {
    const kind = new URL(req.url).searchParams.get('kind') || undefined;
    return Response.json(await listAssets({ kind }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/assets GET'); }
});

export const POST = withAdminAuth(async (req, ctx, user) => {
  try {
    // Hard cap enforced while reading the stream (Content-Length may be absent or wrong).
    const form = await readFormDataWithLimit(req, IMAGE_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD);
    const kind = String(form.get('kind') || '');
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return Response.json({ error: 'Aucun fichier fourni.', code: 'VALIDATION', field: 'file' }, { status: 400 });
    const limit = kind === 'audio' ? AUDIO_MAX_BYTES : IMAGE_MAX_UPLOAD_BYTES;
    if (file.size > limit) return tooLarge(kind === 'audio' ? 'Note vocale trop lourde (5 Mo max).' : 'Image trop lourde (10 Mo max).');
    // The client's file name and MIME type are ignored: the content decides.
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadAsset(kind, buffer, { actorId: actorIdOf(user) });
    return Response.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (e) { return errorResponse(e, 'admin/demo-chat/assets POST'); }
});
