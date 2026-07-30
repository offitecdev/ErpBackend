-- Purchase orders: PDF/detail fields.
--   quoteNumber     — optional quote reference, replaces the free-text order name
--   orderedByName   — "Auftrag": the person placing the order
--   projectName     — project being supplied (shown in the PDF cover card)
--   supplierAddress — snapshot of the supplier address for the PDF recipient block
-- Run with: npx prisma migrate deploy

ALTER TABLE `PurchaseOrder`
  ADD COLUMN `quoteNumber` VARCHAR(191) NULL,
  ADD COLUMN `orderedByName` VARCHAR(191) NULL,
  ADD COLUMN `projectName` VARCHAR(191) NULL,
  ADD COLUMN `supplierAddress` TEXT NULL;

-- The former free-text `name` is superseded by `quoteNumber`; carry any existing
-- label over so nothing typed before this migration is lost.
UPDATE `PurchaseOrder` SET `quoteNumber` = `name` WHERE `name` IS NOT NULL AND `name` <> '';

ALTER TABLE `PurchaseOrder` DROP COLUMN `name`;
