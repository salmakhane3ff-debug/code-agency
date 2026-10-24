-- Add countdown timer support to gifts
ALTER TABLE "gifts" ADD COLUMN IF NOT EXISTS "countdownMinutes" INTEGER NOT NULL DEFAULT 0;
