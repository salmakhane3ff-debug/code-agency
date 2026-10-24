-- Add Bemob conversion tracking columns to orders
-- bemobClickId          — click ID captured at checkout (last_click_id), null if visitor had none
-- bemobConversionSentAt — set only after a successful postback; null = not yet sent (idempotency guard)
-- bemobConversionStatus — "sent" | "failed" | null, for admin visibility on failed attempts
ALTER TABLE "orders" ADD COLUMN "bemobClickId" TEXT;
ALTER TABLE "orders" ADD COLUMN "bemobConversionSentAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "bemobConversionStatus" TEXT;
