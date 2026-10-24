-- Per-affiliate dashboard objectives (nullable → existing affiliates fall back to defaults)
-- goalOrders          — Objectif commandes (null → dashboard default of 5)
-- goalValidReferrals  — Objectif parrainages valides (null → existing computed target)
ALTER TABLE "affiliates" ADD COLUMN "goalOrders" INTEGER;
ALTER TABLE "affiliates" ADD COLUMN "goalValidReferrals" INTEGER;
