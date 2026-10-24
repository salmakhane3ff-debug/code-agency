CREATE TABLE IF NOT EXISTS "abandoned_carts" (
  "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "phone"      TEXT         NOT NULL,
  "fullName"   TEXT,
  "email"      TEXT,
  "city"       TEXT,
  "items"      JSONB        NOT NULL DEFAULT '[]',
  "cartTotal"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "itemCount"  INTEGER      NOT NULL DEFAULT 0,
  "recovered"  BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "abandoned_carts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "abandoned_carts_phone_idx"     ON "abandoned_carts"("phone");
CREATE INDEX IF NOT EXISTS "abandoned_carts_recovered_idx" ON "abandoned_carts"("recovered");
CREATE INDEX IF NOT EXISTS "abandoned_carts_createdAt_idx" ON "abandoned_carts"("createdAt");
