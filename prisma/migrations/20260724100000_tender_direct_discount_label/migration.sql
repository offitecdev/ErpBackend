-- Tender: optional custom display name for the direct discount
-- (e.g. "Winteraktion" instead of the default "Direktrabatt").
ALTER TABLE `Tender`
    ADD COLUMN `directDiscountLabel` VARCHAR(191) NULL;
