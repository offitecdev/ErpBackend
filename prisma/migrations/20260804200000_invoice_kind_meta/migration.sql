-- Invoice kinds (Rechnung / Akonto / Zwischen / Schluss) + business dates and
-- tender meta snapshot for the invoice PDF.
ALTER TABLE `Invoice`
    ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'RECHNUNG',
    ADD COLUMN `invoiceDate` DATETIME(3) NULL,
    ADD COLUMN `dueDate` DATETIME(3) NULL,
    ADD COLUMN `salespersonName` VARCHAR(191) NULL,
    ADD COLUMN `commissionNumber` VARCHAR(191) NULL;

-- Existing partial invoices were interim payments by construction: the first
-- partial per target becomes AKONTO, later ones ZWISCHEN would need ordering —
-- keep it simple and mark all previous PARTIAL invoices as AKONTO.
UPDATE `Invoice` SET `kind` = 'AKONTO' WHERE `billingType` = 'PARTIAL';

-- Backfill invoiceDate from createdAt so old invoices render a date on the PDF.
UPDATE `Invoice` SET `invoiceDate` = `createdAt` WHERE `invoiceDate` IS NULL;
