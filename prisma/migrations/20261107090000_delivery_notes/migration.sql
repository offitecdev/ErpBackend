-- LIEFERSCHEIN (28.09.2026, Vorgabe Samet)
--
-- «Projede nerede gerekiyorsa bu irsaliyeyi uygula» — der Lieferschein eines
-- Auftrags (AB): gelieferte Positionen und Mengen, die auf der Offerte
-- gewählte Projekt- ODER Lieferadresse, Nummer LS-YYYY-NNNNN.
--
-- Nur HINZUGEFÜGT; nichts gelöscht, nichts umbenannt:
--   DeliveryNote       NEU  Kopf des Lieferscheins
--   DeliveryNoteLine   NEU  gelieferte Positionen
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `DeliveryNote` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `salesOrderId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `noteNumber` VARCHAR(32) NOT NULL,
    `deliveryDate` DATETIME(3) NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `customerAddress` TEXT NULL,
    `siteAddressKind` VARCHAR(16) NULL,
    `siteAddress` TEXT NULL,
    `customerReference` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `createdByEmployeeId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DeliveryNote_tenantId_noteNumber_key`(`tenantId`, `noteNumber`),
    INDEX `DeliveryNote_tenantId_salesOrderId_idx`(`tenantId`, `salesOrderId`),
    INDEX `DeliveryNote_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeliveryNoteLine` (
    `id` VARCHAR(191) NOT NULL,
    `deliveryNoteId` VARCHAR(191) NOT NULL,
    `sourcePositionId` VARCHAR(191) NULL,
    `articleId` VARCHAR(191) NULL,
    `positionNumber` VARCHAR(32) NULL,
    `articleCode` VARCHAR(191) NULL,
    `description` TEXT NOT NULL,
    `unit` VARCHAR(191) NULL,
    `orderedQty` DOUBLE NOT NULL DEFAULT 0,
    `deliveredQty` DOUBLE NOT NULL DEFAULT 0,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `DeliveryNoteLine_deliveryNoteId_idx`(`deliveryNoteId`),
    INDEX `DeliveryNoteLine_sourcePositionId_idx`(`sourcePositionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DeliveryNoteLine` ADD CONSTRAINT `DeliveryNoteLine_deliveryNoteId_fkey` FOREIGN KEY (`deliveryNoteId`) REFERENCES `DeliveryNote`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
