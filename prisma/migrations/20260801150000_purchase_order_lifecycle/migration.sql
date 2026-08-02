-- Purchase-order lifecycle extension (price requests + goods receipt + total VAT).
--
-- 1) `PurchaseOrder.vatMode` — 'LINE' (per-row VAT, old behaviour) or 'TOTAL'
--    (one rate applied on totalNet + totalFees, picked in the VAT settings
--    popup of the order detail sheet).
-- 2) `PurchaseOrder.orderVatRate` / `orderVatCountry` — the TOTAL-mode rate and
--    the country label it was picked from (display only).
--
-- New statuses (status stays a free string, no enum migration needed):
--   DRAFT | PRICE_REQUEST | AWAITING_CONFIRMATION | PENDING | UPDATED |
--   TO_BE_STOCKED | COMPLETED
-- Item snapshots gain `calcMode` ('AUTO'|'DIRECT'|'SUPPLIER') and
-- `receivedQuantity`/`receivedAt` (goods receipt) inside the `items` JSON —
-- no column change required.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `PurchaseOrder`
    ADD COLUMN `vatMode` VARCHAR(191) NOT NULL DEFAULT 'LINE',
    ADD COLUMN `orderVatRate` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `orderVatCountry` VARCHAR(191) NULL;
