-- Booster payment split — ADDITIVE migration (no DROP / rename / destructive
-- change). Records, at purchase time, how much of a BALANCE-paid booster came
-- from the top-up balance vs the earnings balance, so approved "Dépôt de solde"
-- top-ups are spendable on boosters but NEVER withdrawable. Defaults are 0;
-- any legacy BALANCE row (both splits 0) is treated as earnings-paid by the
-- accounting layer (conservative: reduces withdrawable, never top-up).

ALTER TABLE "affiliate_booster_purchases" ADD COLUMN IF NOT EXISTS "paidFromTopup"    DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "affiliate_booster_purchases" ADD COLUMN IF NOT EXISTS "paidFromEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0;
