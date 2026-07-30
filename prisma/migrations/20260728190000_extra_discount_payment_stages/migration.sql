-- Tender: second (stacked) document-level discount + payment schedule stages.
ALTER TABLE `Tender`
    ADD COLUMN `extraDiscount` DOUBLE NULL DEFAULT 0,
    ADD COLUMN `extraDiscountLabel` VARCHAR(191) NULL,
    ADD COLUMN `paymentStages` VARCHAR(191) NULL;

-- SalesOrder: schedule copied from the tender at conversion.
ALTER TABLE `SalesOrder`
    ADD COLUMN `paymentStages` VARCHAR(191) NULL;
