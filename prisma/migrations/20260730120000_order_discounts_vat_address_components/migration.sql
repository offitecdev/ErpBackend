-- Order discounts / VAT and DISTINCT postal-address components.
--
-- 1) PurchaseOrder.totalVat — the VAT sum of the order lines. Line-level
--    discount1..3 and vatRate live inside the existing `items` JSON, so no
--    extra columns are needed for them.
-- 2) Postal addresses are stored as distinct components on Supplier, Customer
--    and CustomerLocation. No component repeats another's meaning and there is
--    no generic free-text "address" field: `address` is specifically the
--    street + house number, `addressSupplement` the supplement / apartment.
--    Screens and PDFs collapse the components to at most two lines.
-- Run with: npx prisma migrate deploy

ALTER TABLE `PurchaseOrder`
  ADD COLUMN `totalVat` DOUBLE NOT NULL DEFAULT 0;

-- Supplier only had a single free-text `address`. Keep it as the street line
-- and add the remaining components alongside it.
ALTER TABLE `Supplier`
  ADD COLUMN `addressSupplement` VARCHAR(191) NULL,
  ADD COLUMN `postalCode` VARCHAR(191) NULL,
  ADD COLUMN `city` VARCHAR(191) NULL,
  ADD COLUMN `state` VARCHAR(191) NULL,
  ADD COLUMN `country` VARCHAR(191) NULL;

ALTER TABLE `Customer`
  ADD COLUMN `addressSupplement` VARCHAR(191) NULL,
  ADD COLUMN `state` VARCHAR(191) NULL;

ALTER TABLE `CustomerLocation`
  ADD COLUMN `addressSupplement` VARCHAR(191) NULL,
  ADD COLUMN `state` VARCHAR(191) NULL;
