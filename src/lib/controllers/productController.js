/**
 * src/lib/controllers/productController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin controller layer — validates inputs, delegates to productService,
 * returns HTTP responses.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getAllProducts,
  getProductsByIds,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../services/productService.js';
import {
  badRequest,
  notFound,
  serverError,
} from '../utils/apiResponse.js';
import { isProductLocked, PRODUCT_LOCKED } from '../productLock.js';
import { isAdminRequest } from '../adminSession.js';

// ── GET /api/product ──────────────────────────────────────────────────────────

export async function getProductsHandler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status') || null;
    const idsParam     = searchParams.get('ids')    || null;

    // Fast path: cart requests only need specific products by ID
    if (idsParam) {
      const ids = idsParam.split(',').filter(Boolean).slice(0, 100); // hard cap at 100
      const products = await getProductsByIds(ids);
      return Response.json(products, {
        headers: { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=60' },
      });
    }

    const products = await getAllProducts(statusFilter);

    // WHY: Public active-product list rarely changes; 5-min browser/CDN cache eliminates
    // repeated DB round-trips on every page load. stale-while-revalidate lets the CDN
    // serve the old response instantly while it fetches a fresh one in the background.
    // Admin requests include ?status=all and are excluded from public caching.
    const isPublic = !statusFilter || statusFilter === 'Active';
    const cacheHeader = isPublic
      ? 'public, max-age=300, stale-while-revalidate=60'
      : 'no-store';

    return Response.json(products, {
      headers: { 'Cache-Control': cacheHeader },
    });
  } catch (err) {
    console.error('Product GET error:', err);
    return serverError('Failed to fetch products');
  }
}

// ── GET /api/product/[id] ─────────────────────────────────────────────────────

export async function getProductByIdHandler(req, context) {
  try {
    const { params } = await context;
    const { id } = await params;

    if (!id) return badRequest('Product ID is required');

    const product = await getProductById(id);
    if (!product) return notFound('Product not found');

    // Locked: nobody may read it through the API — only the admin edit form
    // (admin session) still loads the full product.
    if (isProductLocked(product) && !isAdminRequest(req)) {
      return Response.json(
        { error: 'Ce produit est verrouillé', code: PRODUCT_LOCKED },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    return Response.json(product);
  } catch (err) {
    console.error('Product GET by ID error:', err);
    return serverError('Failed to fetch product');
  }
}

// ── Dedup guard for POST (prevents rapid duplicate submissions) ───────────────
const recentCreateRequests = new Map();
const DEDUP_WINDOW_MS = 3000;

// ── POST /api/product ─────────────────────────────────────────────────────────

export async function createProductHandler(req) {
  try {
    const body = await req.json();
    // Key = title + first image (or sku) so empty-title products don't collide
    const title = (body.title || '').trim().toLowerCase();
    const extra = (body.sku || body.images?.[0] || '').toString().slice(0, 32);
    const key = `${title}::${extra}`;
    const now = Date.now();
    const last = recentCreateRequests.get(key);
    if (last && now - last < DEDUP_WINDOW_MS) {
      return Response.json({ error: 'Duplicate request ignored' }, { status: 429 });
    }
    recentCreateRequests.set(key, now);
    // Clean up old entries to avoid memory leak
    if (recentCreateRequests.size > 200) {
      const cutoff = now - DEDUP_WINDOW_MS;
      for (const [k, t] of recentCreateRequests) {
        if (t < cutoff) recentCreateRequests.delete(k);
      }
    }
    const product = await createProduct(body);
    return Response.json(product, { status: 201 });
  } catch (err) {
    console.error('Product POST error:', err);
    return serverError('Failed to create product');
  }
}

// ── PUT /api/product ──────────────────────────────────────────────────────────

export async function updateProductHandler(req) {
  try {
    const body = await req.json();
    const { _id, id } = body;
    const productId = _id || id;

    if (!productId) return badRequest('_id is required for update');

    const product = await updateProduct(productId, body);
    if (!product) return notFound('Product not found');

    return Response.json(product);
  } catch (err) {
    console.error('Product PUT error:', err);
    return serverError('Failed to update product');
  }
}

// ── DELETE /api/product ───────────────────────────────────────────────────────

export async function deleteProductHandler(req) {
  try {
    const body = await req.json();
    const { _id, id } = body;
    const productId = _id || id;

    if (!productId) return badRequest('_id is required for delete');

    const deleted = await deleteProduct(productId);
    if (!deleted) return notFound('Product not found');

    return Response.json({ message: 'Product deleted', _id: productId });
  } catch (err) {
    console.error('Product DELETE error:', err);
    return serverError('Failed to delete product');
  }
}
