-- Migration: add content_items table
-- Replaces the retired MongoDB /api/data + /api/delete generic CRUD endpoints.
-- Each row is one "document" in a named collection stored as JSONB.

CREATE TABLE "content_items" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "collection" TEXT         NOT NULL,
    "data"       JSONB        NOT NULL DEFAULT '{}',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "content_items_collection_idx"           ON "content_items"("collection");
CREATE INDEX "content_items_collection_createdAt_idx" ON "content_items"("collection", "createdAt");
