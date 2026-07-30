-- Purchase order ADDITIONAL FEES (shipping, packaging, assembly…).
--
-- Order-level, not line items: a fee carries only a name and an amount — no
-- quantity, no discount, no VAT rate. It is added to the order total as a net
-- amount, so the grand total is `totalNet + totalFees + totalVat`.
--
-- `additionalFees` holds JSON [{name, amount}] (same snapshot pattern as
-- `items`); `totalFees` is the server-computed sum so lists can show the
-- payable amount without parsing the JSON.
-- Run with: npx prisma migrate deploy

ALTER TABLE `PurchaseOrder`
  ADD COLUMN `additionalFees` TEXT NULL,
  ADD COLUMN `totalFees` DOUBLE NOT NULL DEFAULT 0;
