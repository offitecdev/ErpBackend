-- Stand beim Auftrag (16.09.2026, Schritt 3 / B4): geht ein Auftrag zurück in den Entwurf,
-- zählt die Offerte eine Version hoch, und der Stand, auf dem die verschickte AB beruhte,
-- bleibt als Schnappschuss stehen. Der Auftrag merkt sich die Offertversion.

ALTER TABLE `SalesOrder` ADD COLUMN `tenderVersion` INTEGER NULL;

CREATE TABLE `TenderSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `tenderId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `orderNumber` VARCHAR(191) NULL,
    `reason` VARCHAR(32) NOT NULL,
    `positions` JSON NOT NULL,
    `totals` JSON NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TenderSnapshot_tenantId_tenderId_idx`(`tenantId`, `tenderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
