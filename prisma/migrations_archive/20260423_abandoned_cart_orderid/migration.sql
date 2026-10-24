-- Add orderId column to abandoned_carts
-- Stores the order UUID once the customer completes checkout,
-- so the admin can send them the success page link directly.
ALTER TABLE "abandoned_carts" ADD COLUMN "orderId" TEXT;
