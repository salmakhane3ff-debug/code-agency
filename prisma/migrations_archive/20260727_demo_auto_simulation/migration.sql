-- Demo auto-simulation — ADDITIVE migration (no DROP / rename / destructive change).
-- Adds a background auto-simulation toggle + interval to the demo competition
-- settings. Both columns have safe defaults (OFF, 10s), so existing rows and every
-- production code path are unchanged until an admin explicitly turns auto-sim on.

ALTER TABLE "demo_settings" ADD COLUMN IF NOT EXISTS "autoSimEnabled"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "demo_settings" ADD COLUMN IF NOT EXISTS "autoSimIntervalSec" INTEGER NOT NULL DEFAULT 10;
