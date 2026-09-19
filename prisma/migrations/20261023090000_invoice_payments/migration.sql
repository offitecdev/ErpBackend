-- Zahlungseingänge (17.09.2026, Schritt 7 / G19): eine Rechnung kann in mehreren
-- Teilen bezahlt werden. Jeder Eingang ist eine Zeile; die Rechnung ist «bezahlt»,
-- sobald die Eingänge ihren Betrag decken. Bisher bezahlte Rechnungen bekommen
-- EINEN Eingang über ihren ganzen Betrag, datiert auf ihr Zahlungsdatum.

CREATE TABLE `InvoicePayment` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `paidAt` DATETIME(3) NOT NULL,
    `note` VARCHAR(500) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `InvoicePayment_tenantId_paidAt_idx`(`tenantId`, `paidAt`),
    INDEX `InvoicePayment_invoiceId_idx`(`invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `InvoicePayment` ADD CONSTRAINT `InvoicePayment_invoiceId_fkey`
    FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO `InvoicePayment` (`id`, `tenantId`, `invoiceId`, `amount`, `paidAt`, `note`, `createdById`, `createdAt`)
SELECT CONCAT('pm', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 18)), i.`tenantId`, i.`id`, i.`amount`,
       COALESCE(i.`paidAt`, i.`updatedAt`), NULL, NULL, CURRENT_TIMESTAMP(3)
FROM `Invoice` i
WHERE i.`status` = 'PAID';
