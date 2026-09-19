-- Storno-Rechnung und Gutschrift (17.09.2026, Schritt 6 / E2, E3): ein Gegenbeleg
-- mit eigener RE-Nummer und negativem Betrag zeigt auf die Rechnung, die er
-- zurücknimmt. Der Grund steht wörtlich am Beleg.

ALTER TABLE `Invoice` ADD COLUMN `reversesInvoiceId` VARCHAR(191) NULL;
ALTER TABLE `Invoice` ADD COLUMN `creditReason` TEXT NULL;

CREATE INDEX `Invoice_reversesInvoiceId_idx` ON `Invoice`(`reversesInvoiceId`);

ALTER TABLE `Invoice` ADD CONSTRAINT `Invoice_reversesInvoiceId_fkey`
    FOREIGN KEY (`reversesInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
