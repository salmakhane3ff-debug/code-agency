/**
 * src/lib/services/orderService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All order CRUD operations via Prisma.
 *
 * Frontend compatibility notes:
 *   - Input uses MongoDB field names: name/email/phone, shipping, products.items[]
 *   - Output always includes `_id` (alias of Prisma `id`)
 *   - Order.status is stored as plain TEXT so values like "pending", "success",
 *     "failed", "confirmed", "shipped", "delivered", "cancelled" all work
 *   - Timestamp override is supported on PUT (for admin backdating)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma               from '../prisma.js';
import { mapOrder, parseOrderBody } from '../utils/mappers.js';
import { sendBemobPostback } from '../bemobApi.js';
import { getSettings } from './settingsService.js';
import { syncLinkedAffiliateOrderStatus } from './affiliateSystemService.js';
import { isProductLocked, productLockedError } from '../productLock.js';

/**
 * Product a gift-less free line points at: its id up to the first "::" (so any
 * "<id>::cadeau…" variant resolves to <id>), trimmed.
 */
const freeLineProductId = (item) => String(item.productId || item._id || '').split('::')[0].trim() || null;

// ── Analytics helper ──────────────────────────────────────────────────────────
/**
 * Increment ProductAnalytics order counters for every item in a new order.
 *
 * Always increments the grand-total `orders` counter.
 * Additionally increments one source-specific counter based on `orderSource`:
 *   "product"   → productOrders
 *   "landing"   → landingOrders
 *   "affiliate" → affiliateOrders
 *   (anything else / undefined → only the grand total is incremented)
 *
 * Uses upsert so the row is auto-created on first order.
 * Called fire-and-forget — never blocks the order response.
 *
 * @param {Array}  items       — Prisma OrderItem rows (productId + quantity)
 * @param {string} orderSource — "product" | "landing" | "affiliate" | undefined
 */
async function incrementProductOrders(items, orderSource) {
  const updates = (items || []).filter((item) => item.productId);
  if (!updates.length) return;

  // Build the source-specific field name (null → skip source counter)
  const sourceField =
    orderSource === 'product'   ? 'productOrders'   :
    orderSource === 'landing'   ? 'landingOrders'   :
    orderSource === 'affiliate' ? 'affiliateOrders' :
    null;

  await Promise.all(
    updates.map((item) => {
      const qty = item.quantity ?? 1;

      const createData = {
        productId:    item.productId,
        orders:       qty,
        ...(sourceField ? { [sourceField]: qty } : {}),
      };

      const updateData = {
        orders: { increment: qty },
        ...(sourceField ? { [sourceField]: { increment: qty } } : {}),
      };

      return prisma.productAnalytics.upsert({
        where:  { productId: item.productId },
        create: createData,
        update: updateData,
      });
    })
  );
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** All orders, newest first. */
export async function getAllOrders() {
  const orders = await prisma.order.findMany({
    include:  { items: true },
    orderBy:  { createdAt: 'desc' },
  });
  return orders.map(mapOrder);
}

/**
 * Search orders by orderId (id or sessionId), phone, or email.
 * Any combination of the three may be provided.
 */
export async function searchOrders({ orderId, phone, email }) {
  const OR = [];

  if (orderId) {
    OR.push({ sessionId: orderId });
    OR.push({ id: orderId });
  }
  if (phone) {
    OR.push({ customerPhone: phone });
  }
  if (email) {
    OR.push({ customerEmail: email });
  }

  const orders = await prisma.order.findMany({
    where:   OR.length > 0 ? { OR } : {},
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  });
  return orders.map(mapOrder);
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Create a new order from the frontend checkout payload.
 *
 * Handles sessionId deduplication: if an order with the same sessionId
 * already exists, returns it without creating a duplicate.
 *
 * Returns: { duplicate: boolean, order: MappedOrder }
 */
/**
 * Create a new order with FULL server-side price resolution.
 *
 * SECURITY MODEL:
 *   - item.price / item.sellingPrice / item.discount are IGNORED entirely
 *   - Every paid item's price is fetched from prisma.product
 *   - Gift items require a valid giftId that resolves in prisma.gift
 *   - order.status is ALWAYS forced to 'pending'
 *   - All financial values come from the database, never from the client
 */
export async function createOrder(body) {
  const { sessionId, orderSource } = body;
  const validSource = ['product', 'landing', 'affiliate'].includes(orderSource)
    ? orderSource
    : undefined;

  // ── Dedup check ──────────────────────────────────────────────────────────
  if (sessionId) {
    const existing = await prisma.order.findUnique({
      where:   { sessionId },
      include: { items: true },
    });
    if (existing) return { duplicate: true, order: mapOrder(existing) };
  }

  const { _items, createdAt: _createdAt, updatedAt: _updatedAt, ...orderData } = parseOrderBody(body);

  // SECURITY: Force status — never trust client
  orderData.status = 'pending';

  // ── Validate affiliateId FK to prevent P2003 ──────────────────────────────
  // The client stores affiliateId in localStorage which can be stale, from a
  // different environment, or simply wrong. A bad ID causes a FK violation and
  // kills the entire order. Verify it exists; null it out silently if not.
  if (orderData.affiliateId) {
    const affiliateExists = await prisma.affiliate.count({
      where: { id: orderData.affiliateId },
    });
    if (affiliateExists === 0) {
      console.warn(`[order] affiliateId "${orderData.affiliateId}" not found — cleared`);
      orderData.affiliateId = null;
    }
  }

  if (orderData.userId) {
    const userExists = await prisma.user.count({
      where: { id: orderData.userId },
    });
    if (userExists === 0) {
      orderData.userId = null;
    }
  }

  if (!_items || _items.length === 0) {
    throw Object.assign(new Error('Order must contain at least one item'), { code: 'EMPTY_ORDER' });
  }

  // ── Batch-fetch gifts first, then all products in one query ─────────────
  // ORDER: gifts → paid products + gift products together.
  // This prevents P2003 FK violations: OrderItem.productId must exist in
  // the products table. Gift items use the productId from the Gift DB record
  // (not the client-supplied value). We verify it exists before using it.
  const clientGiftIds = [...new Set(
    _items.map((i) => i.giftId || i._giftId).filter(Boolean),
  )];

  const paidProductIds = [...new Set(
    _items
      .filter((i) => !(i.isFreeGift && (i.giftId || i._giftId)))
      .map((i) => i.productId || i._id)
      .filter(Boolean),
  )];

  // Step 1: fetch gifts
  const dbGifts = clientGiftIds.length > 0
    ? await prisma.gift.findMany({
        where:  { id: { in: clientGiftIds }, active: true },
        select: { id: true, productId: true },
      })
    : [];

  // Step 2: collect all productIds we need (paid + gift product refs + the
  // product a gift-less free line points at, so its lock can be checked)
  const giftProductIds = dbGifts.map((g) => g.productId).filter(Boolean);
  const freeLineIds    = _items
    .filter((i) => (i.isFreeGift || i._isGift) && !(i.giftId || i._giftId))
    .map(freeLineProductId)
    .filter(Boolean);
  const allProductIds  = [...new Set([...paidProductIds, ...giftProductIds, ...freeLineIds])];

  // Step 3: single product fetch covers both paid items and gift products
  const dbProducts = allProductIds.length > 0
    ? await prisma.product.findMany({
        where:  { id: { in: allProductIds } },
        select: { id: true, salePrice: true, regularPrice: true, isActive: true, isLocked: true },
      })
    : [];

  const productMap   = new Map(dbProducts.map((p) => [p.id, p]));
  const validGiftIds = new Set(dbGifts.map((g) => g.id));
  // giftId → verified DB productId (null when the product row is missing)
  const giftProductMap = new Map(
    dbGifts.map((g) => [g.id, productMap.has(g.productId) ? g.productId : null]),
  );

  // ── Resolve server-authoritative price for every item ────────────────────
  const resolvedItems = [];

  for (const item of _items) {
    const rawId          = item.productId || item._id || null;
    const resolvedGiftId = item.giftId || item._giftId || null;
    const isGift         = Boolean(item.isFreeGift && resolvedGiftId && validGiftIds.has(resolvedGiftId));

    // ── Fallback cadeau: isFreeGift=true but no giftId (::cadeau suffix or _isGift) ─
    const isCadeauFallback = Boolean(
      (item.isFreeGift || item._isGift) &&
      !resolvedGiftId &&
      (String(rawId || '').includes('::cadeau') || item._isGift)
    );

    if (isGift || isCadeauFallback) {
      // Admin product lock: a locked product is not given away either (Gift
      // System gift, "2+1" bundle or ::cadeau line). The free line is dropped;
      // the paid items of the order are unaffected.
      const refId = isGift ? giftProductMap.get(resolvedGiftId) : freeLineProductId(item);
      if (refId && isProductLocked(productMap.get(refId))) {
        console.warn(`[order] free line for locked product ${refId} dropped`);
        continue;
      }
      // Use the DB-verified productId from giftProductMap (satisfies FK constraint).
      // Falls back to null — OrderItem.productId is optional in schema.
      resolvedItems.push({
        productId:       isGift ? (giftProductMap.get(resolvedGiftId) ?? null) : null,
        quantity:        1,
        price:           0,
        regularPrice:    null,
        productSnapshot: { title: item.title, images: item.images || [], variants: item.variants || [] },
      });
      continue;
    }

    // ── Paid item: must have a real productId with a live DB price ────────
    if (!rawId) {
      throw Object.assign(
        new Error('productId is required for all non-gift items'),
        { code: 'MISSING_PRODUCT_ID' },
      );
    }

    const dbProduct = productMap.get(rawId);
    if (!dbProduct) {
      throw Object.assign(
        new Error(`Product not found: ${rawId}`),
        { code: 'PRODUCT_NOT_FOUND' },
      );
    }
    if (!dbProduct.isActive) {
      throw Object.assign(
        new Error(`Product is unavailable: ${rawId}`),
        { code: 'PRODUCT_INACTIVE' },
      );
    }
    // Admin product lock: nobody can buy a locked product (checkout, landing
    // pages, offers and any direct POST all land here). Free lines for a
    // locked product are dropped above.
    if (isProductLocked(dbProduct)) throw productLockedError(rawId);

    // Canonical server-side price: salePrice takes precedence over regularPrice
    const price = dbProduct.salePrice ?? dbProduct.regularPrice ?? 0;
    if (!Number.isFinite(price) || price < 0) {
      throw Object.assign(new Error(`Product has an invalid price: ${rawId}`), { code: 'INVALID_PRICE' });
    }

    const qty = parseInt(item.quantity, 10) || 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      throw Object.assign(new Error('Quantity must be between 1 and 1000'), { code: 'INVALID_QUANTITY' });
    }

    resolvedItems.push({
      productId:       rawId,
      quantity:        qty,
      price,                                    // ← always from DB
      regularPrice:    dbProduct.regularPrice ?? null,
      productSnapshot: { title: item.title, images: item.images || [], variants: item.variants || [] },
    });
  }

  // Only reachable when every line was a dropped free line for a locked product.
  if (resolvedItems.length === 0) throw productLockedError('order');

  // ── Persist inside a transaction so order + items are atomic ─────────────
  const order = await prisma.$transaction(async (tx) => {
    return tx.order.create({
      data: {
        ...orderData,
        items: { create: resolvedItems },
      },
      include: { items: true },
    });
  });

  // Fire-and-forget analytics — never blocks the order response
  incrementProductOrders(order.items, validSource).catch((err) =>
    console.error('[productAnalytics] increment failed:', err?.message ?? err),
  );

  return { duplicate: false, order: mapOrder(order) };
}

/**
 * Update an order by its Prisma `id` (= the `_id` the frontend sends).
 *
 * Only known Prisma columns are written; extra unknown keys are silently
 * discarded so that the flexible old MongoDB behaviour is preserved without
 * risking Prisma "unknown field" errors.
 *
 * Returns the mapped order, or null when not found.
 */
export async function updateOrder(id, body) {
  // Pull out all known fields; ignore the rest
  const {
    _id, id: _bodyId,
    name, customerName,
    email, customerEmail,
    phone, customerPhone,
    shipping, shippingAddress,
    products: _products,
    paymentDetails,
    paymentMethod,
    paymentStatus,
    paymentTotal,
    status,
    utm_source, utmSource,
    sessionId,
    affiliateId,
    campaignSource,
    userId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
  } = body;

  const pymtDetails =
    paymentDetails && typeof paymentDetails === 'object' ? paymentDetails : null;

  const data = {};

  if (name          !== undefined) data.customerName    = name;
  if (customerName  !== undefined) data.customerName    = customerName;
  if (email         !== undefined) data.customerEmail   = email;
  if (customerEmail !== undefined) data.customerEmail   = customerEmail;
  if (phone         !== undefined) data.customerPhone   = phone;
  if (customerPhone !== undefined) data.customerPhone   = customerPhone;

  if (shipping        !== undefined) data.shippingAddress = shipping;
  if (shippingAddress !== undefined) data.shippingAddress = shippingAddress;

  if (pymtDetails !== null) {
    data.paymentDetails  = pymtDetails;
    if (pymtDetails.paymentMethod)                data.paymentMethod  = pymtDetails.paymentMethod;
    if (pymtDetails.status || pymtDetails.paymentStatus)
      data.paymentStatus = pymtDetails.status || pymtDetails.paymentStatus;
    if (pymtDetails.total) {
      const pt = parseFloat(pymtDetails.total);
      if (Number.isFinite(pt) && pt >= 0 && pt <= 1_000_000) data.paymentTotal = pt;
    }
  }
  if (paymentMethod  !== undefined) data.paymentMethod  = paymentMethod;
  if (paymentStatus  !== undefined) data.paymentStatus  = paymentStatus;
  if (paymentTotal   !== undefined) {
    const pt = parseFloat(paymentTotal);
    if (!Number.isFinite(pt) || pt < 0 || pt > 1_000_000) {
      throw Object.assign(new Error('paymentTotal must be a finite number between 0 and 1,000,000'), { code: 'INVALID_PAYMENT_TOTAL' });
    }
    data.paymentTotal = pt;
  }

  if (status        !== undefined) data.status   = status;
  if (utm_source    !== undefined) data.utmSource = utm_source;
  if (utmSource     !== undefined) data.utmSource = utmSource;
  if (sessionId     !== undefined) data.sessionId = sessionId;
  if (affiliateId   !== undefined) data.affiliateId   = affiliateId;
  if (campaignSource !== undefined) data.campaignSource = campaignSource;
  if (userId        !== undefined) data.userId    = userId;

  // Timestamp overrides (admin backdating)
  if (_createdAt !== undefined) data.createdAt = new Date(_createdAt);
  if (_updatedAt !== undefined) data.updatedAt = new Date(_updatedAt);

  // ── Bemob conversion trigger ────────────────────────────────────────────
  // Fires ONLY on a genuine transition into CONFIRMED (previous status was
  // anything else) AND only if Bemob has not already been successfully
  // notified for this order. bemobConversionSentAt is set ONLY by a
  // successful send (see triggerBemobConversion below) — it is therefore a
  // complete, sufficient signal for "has this order already converted",
  // without needing to also check bemobConversionStatus here. This is what
  // lets a previously-FAILED postback be retried by a later CONFIRMED
  // transition (e.g. CONFIRMED -> SHIPPED -> CONFIRMED again — sentAt is
  // still null after a failure), while permanently preventing a re-send
  // once a postback has already succeeded (sentAt is set, guard excludes
  // it even if status later cycles back to CONFIRMED).
  //
  // bemobConversionSentAt: null is a direct equality-to-null check, not a
  // negation — unlike a negated equals/not filter on a nullable column,
  // this has no NULL-comparison ambiguity to worry about (see Prisma's own
  // documented `where: { content: null }` pattern for filtering on null
  // fields). bemobConversionStatus remains on the Order model purely for
  // admin visibility / logging ("sent" | "failed" | null) and is
  // deliberately NOT part of this WHERE clause.
  //
  // Every other update — including edits to an order that is already
  // CONFIRMED, or a status change to any other value — takes the existing
  // plain-update path below, completely unchanged.
  // ── Fake Orders Engine guard ──────────────────────────────────────────────
  // Fake orders reuse this exact status-update path, but must NEVER trigger any
  // external integration. We read isFake once: a fake order skips the Bemob
  // (CONFIRMED) branch entirely and, after its status is written, syncs the
  // change to its linked AffiliateOrder through the SAME delivery-credit engine
  // real orders use (activateReferralIfDelivered). Real orders are unaffected.
  const meta = await prisma.order.findUnique({ where: { id }, select: { isFake: true } });
  const isFakeOrder = Boolean(meta?.isFake);

  const isConfirmingNow = !isFakeOrder
    && typeof data.status === 'string'
    && data.status.toUpperCase() === 'CONFIRMED';

  if (isConfirmingNow) {
    // Atomic guard: updateMany's WHERE clause is evaluated and the row is
    // written in a single database operation, so two concurrent requests
    // for the same order can never both see "eligible to trigger" — only
    // one can ever match this WHERE clause and perform the write. This is
    // the mechanism that makes "never trigger twice" hold even under a race
    // (two admins, a double-click, or a retried request), not just under
    // normal sequential use.
    const result = await prisma.order.updateMany({
      where: {
        id,
        bemobConversionSentAt: null,
        NOT: { status: { equals: 'CONFIRMED', mode: 'insensitive' } },
      },
      data,
    });

    if (result.count === 1) {
      // We performed the actual NEW→CONFIRMED transition — fire the Bemob
      // postback. Order status changes are never blocked by this: failures
      // are caught and logged inside triggerBemobConversion, never thrown
      // back to the caller.
      const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
      if (!order) return null; // record not found (shouldn't happen here, but stay safe)

      triggerBemobConversion(order).catch((err) =>
        console.error('[bemob] postback trigger failed:', err?.message ?? err),
      );
      return mapOrder(order);
    }

    // result.count === 0: the guarded write above did NOT apply `data`.
    // This now happens for two distinct reasons that must be told apart:
    //   (a) status was already CONFIRMED — no real transition occurred.
    //   (b) status was NOT already CONFIRMED, but bemobConversionSentAt was
    //       already set (Bemob was already sent successfully for this
    //       order) — a real transition IS happening, it just must not
    //       re-trigger Bemob.
    // In case (b) the status change itself must still be written — it is
    // the requested, real edit; only the Bemob trigger is suppressed.
    // We re-check here (a second, ordinary read) purely to decide whether
    // status still needs writing; this does not reintroduce a race for the
    // *trigger* decision, since that was already settled atomically above.
    const current = await prisma.order.findUnique({ where: { id }, select: { status: true } });
    if (!current) return null; // record not found

    const wasAlreadyConfirmed = (current.status || '').toUpperCase() === 'CONFIRMED';
    const writeData = wasAlreadyConfirmed
      ? (() => { const { status: _drop, ...rest } = data; return rest; })()
      : data; // not previously CONFIRMED — Bemob already sent; still write status

    try {
      const order = await prisma.order.update({
        where:   { id },
        data:    writeData,
        include: { items: true },
      });
      return mapOrder(order);
    } catch (err) {
      if (err.code === 'P2025') return null; // record not found
      throw err;
    }
  }

  try {
    const order = await prisma.order.update({
      where:   { id },
      data,
      include: { items: true },
    });

    // Fake orders: propagate the status to the linked AffiliateOrder so the
    // affiliate's "Mes commandes", wallet, commission, delivered-count and
    // ranking update through the existing engine. No external integration runs.
    if (isFakeOrder && data.status !== undefined) {
      await syncLinkedAffiliateOrderStatus(id, data.status).catch((e) =>
        console.error('[fake-order] status sync failed:', e?.message ?? e),
      );
    }

    return mapOrder(order);
  } catch (err) {
    if (err.code === 'P2025') return null; // record not found
    throw err;
  }
}

/**
 * Send the Bemob conversion postback for an order that has just transitioned
 * into CONFIRMED, and record the outcome on the order itself.
 *
 * Called fire-and-forget from updateOrder() — never awaited by the admin's
 * request, and any failure here must never surface as a failure of the
 * status update itself (the order is already CONFIRMED in the database by
 * the time this runs).
 */
async function triggerBemobConversion(order) {
  if (!order.bemobClickId) {
    // No click ID was ever attached to this order (organic/direct visitor,
    // or it predates this feature) — nothing to report to Bemob.
    return;
  }

  // Same settings shape/pattern as the Meta Pixel integration in
  // facebookCapi.js's route: a sub-key on the "integrations" settings row,
  // gated by its own enabled flag. No business logic from this service
  // leaks into bemobApi.js itself — it only ever receives the resolved
  // template string.
  const cfg       = await getSettings('integrations');
  const bemobCfg  = cfg?.bemob;

  if (!bemobCfg?.enabled) {
    return; // Bemob integration not enabled — nothing to send
  }

  const postbackUrlTemplate = bemobCfg?.postbackUrl;
  if (!postbackUrlTemplate) {
    console.error('[bemob] integration is enabled but no postbackUrl is configured — order', order.id);
    await prisma.order.update({
      where: { id: order.id },
      data:  { bemobConversionStatus: 'failed' },
    }).catch((updateErr) =>
      console.error('[bemob] failed to record failure status for order', order.id, ':', updateErr?.message ?? updateErr),
    );
    return;
  }

  try {
    await sendBemobPostback(postbackUrlTemplate, {
      clickId: order.bemobClickId,
      payout:  order.paymentTotal ?? undefined,
      orderId: order.id,
    });

    await prisma.order.update({
      where: { id: order.id },
      data:  { bemobConversionSentAt: new Date(), bemobConversionStatus: 'sent' },
    });
  } catch (err) {
    console.error('[bemob] postback failed for order', order.id, ':', err?.message ?? err);
    await prisma.order.update({
      where: { id: order.id },
      data:  { bemobConversionStatus: 'failed' },
    }).catch((updateErr) =>
      console.error('[bemob] failed to record failure status for order', order.id, ':', updateErr?.message ?? updateErr),
    );
  }
}

/** Delete an order by its Prisma UUID. Returns true on success, false if not found. */
export async function deleteOrder(id) {
  try {
    await prisma.order.delete({ where: { id } });
    return true;
  } catch (err) {
    if (err.code === 'P2025') return false;
    throw err;
  }
}
