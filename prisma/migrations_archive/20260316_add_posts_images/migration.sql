-- ============================================================================
--  Migration: 20260316_add_posts_images
--  Adds the `posts` table (Blog + CMS Pages) and `images` table.
--  Run AFTER 20260316_init.
-- ============================================================================

-- ── posts ─────────────────────────────────────────────────────────────────────
-- Replaces the MongoDB "Posts" collection (shared by /api/blog + /api/pages).
-- category = "Blog" | "Page"
-- Promoted key fields indexed; all other content in `data` JSONB.

CREATE TABLE "posts" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "title"     TEXT         NOT NULL,
    "slug"      TEXT         NOT NULL,
    "category"  TEXT         NOT NULL,
    "status"    TEXT         NOT NULL DEFAULT 'Draft',
    "data"      JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "posts_slug_key"               ON "posts"("slug");
CREATE INDEX        "posts_category_idx"           ON "posts"("category");
CREATE INDEX        "posts_status_category_idx"    ON "posts"("status", "category");

-- ── images ────────────────────────────────────────────────────────────────────
-- Replaces the MongoDB "Images" collection (/api/image).
-- Tracks local-upload image records (name + /uploads/<file> URL).

CREATE TABLE "images" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"      TEXT         NOT NULL,
    "url"       TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);
