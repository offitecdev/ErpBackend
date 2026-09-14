-- Mail-Entwürfe eines Auftrags (14.09.2026).
--
-- Das Mailfenster der Auftragsseite speichert halbfertige Mails je Auftrag.
-- Keine Spalte auf `PurchaseOrder`: «manuell gesendet» steht als Vorsilbe
-- `manual:` in `emailRecipient` (siehe inventory.routes.ts).

CREATE TABLE IF NOT EXISTS `PurchaseOrderMailDraft` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `toEmail` VARCHAR(191) NULL,
    `ccEmails` TEXT NULL,
    `subject` VARCHAR(200) NOT NULL DEFAULT '',
    `message` TEXT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PurchaseOrderMailDraft_tenantId_orderId_idx`(`tenantId`, `orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
