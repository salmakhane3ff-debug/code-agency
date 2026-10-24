-- ============================================================================
--  Migration: 20260316_init
--  Initial schema for Ecommerce + Affiliate + Landing Page + Tracking Platform
--  Run this against your PostgreSQL database to apply the schema.
-- ============================================================================

-- ── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "Role" AS ENUM ('ADMIN', 'AFFILIATE', 'CUSTOMER');
-- OrderStatus enum is intentionally NOT created.
-- Order.status is stored as TEXT to preserve all frontend status strings:
-- "pending" | "success" | "failed" | "confirmed" | "shipped" | "delivered" | "cancelled"
-- CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED');
CREATE TYPE "FeedbackType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO');
CREATE TYPE "FeedbackStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SCHEDULED');
CREATE TYPE "CampaignSource" AS ENUM ('TIKTOK', 'INSTAGRAM', 'PUSH_ADS', 'NATIVE_ADS', 'DIRECT', 'OTHER');

-- ── users ───────────────────────────────────────────────────────────────────

CREATE TABLE "users" (
    "id"        TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "email"     TEXT        NOT NULL,
    "password"  TEXT        NOT NULL,
    "name"      TEXT        NOT NULL,
    "role"      "Role"      NOT NULL DEFAULT 'CUSTOMER',
    "isActive"  BOOLEAN     NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_email_idx" ON "users"("email");

-- ── landing_pages ────────────────────────────────────────────────────────────

CREATE TABLE "landing_pages" (
    "id"        TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "title"     TEXT        NOT NULL,
    "slug"      TEXT        NOT NULL,
    "isActive"  BOOLEAN     NOT NULL DEFAULT true,
    "sections"  JSONB       NOT NULL DEFAULT '[]',
    "views"     INTEGER     NOT NULL DEFAULT 0,
    "clicks"    INTEGER     NOT NULL DEFAULT 0,
    "sales"     INTEGER     NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "landing_pages_slug_key" ON "landing_pages"("slug");
CREATE INDEX "landing_pages_slug_idx" ON "landing_pages"("slug");
CREATE INDEX "landing_pages_isActive_idx" ON "landing_pages"("isActive");

-- ── products ────────────────────────────────────────────────────────────────

CREATE TABLE "products" (
    "id"               TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "title"            TEXT             NOT NULL,
    "description"      TEXT,
    "shortDescription" TEXT,
    -- Pricing
    "regularPrice"     DOUBLE PRECISION NOT NULL,
    "salePrice"        DOUBLE PRECISION,
    "costPerItem"      DOUBLE PRECISION,
    -- Media & variants
    "images"           JSONB            NOT NULL DEFAULT '[]',
    "variants"         JSONB            NOT NULL DEFAULT '[]',
    -- Inventory
    "sku"              TEXT,
    "barcode"          TEXT,
    "stockQuantity"    INTEGER,
    "stockStatus"      TEXT             NOT NULL DEFAULT 'In Stock',
    -- Branding & merchandising
    "brand"            TEXT,
    "supplier"         TEXT,
    "tags"             TEXT,
    "productLabel"     TEXT,
    -- Categorisation (array of collection-name strings)
    "collections"      JSONB            NOT NULL DEFAULT '[]',
    -- Visibility
    "isActive"         BOOLEAN          NOT NULL DEFAULT true,
    "status"           TEXT             NOT NULL DEFAULT 'Active',
    -- Social proof
    "rating"           DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingsCount"     INTEGER          NOT NULL DEFAULT 0,
    "reviewsCount"     INTEGER          NOT NULL DEFAULT 0,
    "feedbackCount"    INTEGER          NOT NULL DEFAULT 0,
    -- Promotions
    "limitedTimeDeal"  JSONB,
    -- FK
    "landingPageId"    TEXT,
    "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "products_isActive_idx"     ON "products"("isActive");
CREATE INDEX "products_status_idx"        ON "products"("status");
CREATE INDEX "products_landingPageId_idx" ON "products"("landingPageId");

ALTER TABLE "products"
    ADD CONSTRAINT "products_landingPageId_fkey"
    FOREIGN KEY ("landingPageId") REFERENCES "landing_pages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── collections ───────────────────────────────────────────────────────────────

CREATE TABLE "collections" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "title"       TEXT         NOT NULL,
    "slug"        TEXT,
    "description" TEXT,
    "image"       TEXT,
    "isActive"    BOOLEAN      NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collections_title_key"    ON "collections"("title");
CREATE UNIQUE INDEX "collections_slug_key"     ON "collections"("slug") WHERE "slug" IS NOT NULL;
CREATE INDEX        "collections_title_idx"    ON "collections"("title");
CREATE INDEX        "collections_isActive_idx" ON "collections"("isActive");

-- ── affiliates ──────────────────────────────────────────────────────────────

CREATE TABLE "affiliates" (
    "id"              TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "username"        TEXT             NOT NULL,
    "commissionRate"  DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "isActive"        BOOLEAN          NOT NULL DEFAULT true,
    "totalClicks"     INTEGER          NOT NULL DEFAULT 0,
    "totalOrders"     INTEGER          NOT NULL DEFAULT 0,
    "totalCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userId"          TEXT             NOT NULL,
    "createdAt"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "affiliates_username_key" ON "affiliates"("username");
CREATE UNIQUE INDEX "affiliates_userId_key"   ON "affiliates"("userId");
CREATE INDEX "affiliates_username_idx" ON "affiliates"("username");
CREATE INDEX "affiliates_isActive_idx" ON "affiliates"("isActive");

ALTER TABLE "affiliates"
    ADD CONSTRAINT "affiliates_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── orders ──────────────────────────────────────────────────────────────────

CREATE TABLE "orders" (
    "id"              TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
    "sessionId"       TEXT,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "customerName"    TEXT          NOT NULL,
    "customerEmail"   TEXT,
    "customerPhone"   TEXT,
    "shippingAddress" JSONB         NOT NULL,
    "paymentMethod"   TEXT,
    "paymentStatus"   TEXT                   DEFAULT 'pending',
    "paymentTotal"    DOUBLE PRECISION,
    "paymentDetails"  JSONB,
    "campaignSource"  "CampaignSource",
    "utmSource"       TEXT,
    "affiliateId"     TEXT,
    "userId"          TEXT,
    "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_sessionId_key"     ON "orders"("sessionId");
CREATE INDEX "orders_status_idx"               ON "orders"("status");
CREATE INDEX "orders_affiliateId_idx"          ON "orders"("affiliateId");
CREATE INDEX "orders_customerPhone_idx"        ON "orders"("customerPhone");
CREATE INDEX "orders_customerEmail_idx"        ON "orders"("customerEmail");
CREATE INDEX "orders_createdAt_idx"            ON "orders"("createdAt");

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── order_items ─────────────────────────────────────────────────────────────

CREATE TABLE "order_items" (
    "id"              TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "orderId"         TEXT             NOT NULL,
    -- Nullable: snapshot captures all display data at purchase time, so a missing
    -- or later-deleted product does not break order history or creation.
    "productId"       TEXT,
    "quantity"        INTEGER          NOT NULL,
    "price"           DOUBLE PRECISION NOT NULL,
    "regularPrice"    DOUBLE PRECISION,
    "productSnapshot" JSONB,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── feedbacks ───────────────────────────────────────────────────────────────

CREATE TABLE "feedbacks" (
    "id"            TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "type"          "FeedbackType"   NOT NULL,
    "status"        "FeedbackStatus" NOT NULL DEFAULT 'PENDING',
    "textContent"   TEXT,
    "mediaUrl"      TEXT,
    "mediaPublicId" TEXT,
    "authorName"    TEXT,
    "rating"        INTEGER          NOT NULL DEFAULT 5,
    "isFeatured"    BOOLEAN          NOT NULL DEFAULT false,
    "publishAt"     TIMESTAMP(3),
    "publishedAt"   TIMESTAMP(3),
    "productId"     TEXT,
    "userId"        TEXT,
    "createdAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedbacks_status_publishAt_idx" ON "feedbacks"("status", "publishAt");
CREATE INDEX "feedbacks_productId_idx"        ON "feedbacks"("productId");
CREATE INDEX "feedbacks_isFeatured_idx"       ON "feedbacks"("isFeatured");

ALTER TABLE "feedbacks"
    ADD CONSTRAINT "feedbacks_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "feedbacks"
    ADD CONSTRAINT "feedbacks_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── affiliate_clicks ─────────────────────────────────────────────────────────

CREATE TABLE "affiliate_clicks" (
    "id"          TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "affiliateId" TEXT             NOT NULL,
    "ipAddress"   TEXT,
    "userAgent"   TEXT,
    "source"      "CampaignSource",
    "landingPage" TEXT,
    "referer"     TEXT,
    "createdAt"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_clicks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "affiliate_clicks_affiliateId_createdAt_idx"
    ON "affiliate_clicks"("affiliateId", "createdAt");

ALTER TABLE "affiliate_clicks"
    ADD CONSTRAINT "affiliate_clicks_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── settings ─────────────────────────────────────────────────────────────────

CREATE TABLE "settings" (
    "id"        TEXT         NOT NULL,
    "data"      JSONB        NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- Seed default settings rows
INSERT INTO "settings" ("id", "data", "updatedAt") VALUES
  ('store',        '{}', CURRENT_TIMESTAMP),
  ('payment',      '{}', CURRENT_TIMESTAMP),
  ('delivery',     '{"dispatchAfterHours":24,"inTransitAfterHours":48,"outForDeliveryAfterHours":96,"deliveredAfterHours":120,"autoUpdateStatus":true}', CURRENT_TIMESTAMP),
  ('integrations', '{}', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- ── tracking_events ──────────────────────────────────────────────────────────

CREATE TABLE "tracking_events" (
    "id"             TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
    "event"          TEXT             NOT NULL,
    "sessionId"      TEXT,
    "affiliateId"    TEXT,
    "productId"      TEXT,
    "landingPageId"  TEXT,
    "orderId"        TEXT,
    "campaignSource" "CampaignSource",
    "utmSource"      TEXT,
    "ipAddress"      TEXT,
    "userAgent"      TEXT,
    "referer"        TEXT,
    "extraData"      JSONB,
    "createdAt"      TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tracking_events_event_createdAt_idx" ON "tracking_events"("event", "createdAt");
CREATE INDEX "tracking_events_affiliateId_idx"     ON "tracking_events"("affiliateId");
CREATE INDEX "tracking_events_campaignSource_idx"  ON "tracking_events"("campaignSource");
CREATE INDEX "tracking_events_sessionId_idx"       ON "tracking_events"("sessionId");
