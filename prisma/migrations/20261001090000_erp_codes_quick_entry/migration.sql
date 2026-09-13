-- ERP-Codes, Schnellerfassung per Barcode und kategorisierte Lagerbewegungen
-- (10.09.2026). Alles additiv: neue NULL-Spalten, neue Tabellen, Indizes.

-- Artikel: Modellnummer (freiwillig) und Seriennummer (freiwillig, je Mandant
-- eindeutig — MySQL laesst mehrere NULL in einem eindeutigen Schluessel zu).
ALTER TABLE `Article`
    ADD COLUMN `modelNumber` VARCHAR(120) NULL,
    ADD COLUMN `serialNumber` VARCHAR(120) NULL;
CREATE UNIQUE INDEX `Article_tenantId_serialNumber_key` ON `Article`(`tenantId`, `serialNumber`);
CREATE INDEX `Article_tenantId_supplierBarcode_idx` ON `Article`(`tenantId`, `supplierBarcode`);
CREATE INDEX `Article_tenantId_modelNumber_idx` ON `Article`(`tenantId`, `modelNumber`);

-- Lagerbewegung: Herkunft + der beim Scan gelesene Barcode / die Seriennummer.
ALTER TABLE `StockMovement`
    ADD COLUMN `origin` VARCHAR(24) NULL,
    ADD COLUMN `scannedBarcode` VARCHAR(120) NULL,
    ADD COLUMN `serialNumber` VARCHAR(120) NULL;
CREATE INDEX `StockMovement_tenantId_origin_transactionDate_idx` ON `StockMovement`(`tenantId`, `origin`, `transactionDate`);

-- Code-Einstellungen: Kategorie (ELK) und Nummernkreis (PLC → ELK-PLC-00001).
CREATE TABLE `ArticleCodeCategory` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(8) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ArticleCodeCategory_tenantId_code_key`(`tenantId`, `code`),
    INDEX `ArticleCodeCategory_tenantId_sortOrder_idx`(`tenantId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ArticleCodeScheme` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(8) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `startNumber` INTEGER NOT NULL DEFAULT 1,
    `lastNumber` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `activatedById` VARCHAR(191) NULL,
    `activatedAt` DATETIME(3) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ArticleCodeScheme_tenantId_categoryId_code_key`(`tenantId`, `categoryId`, `code`),
    INDEX `ArticleCodeScheme_tenantId_isActive_idx`(`tenantId`, `isActive`),
    INDEX `ArticleCodeScheme_categoryId_idx`(`categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ArticleCodeScheme`
    ADD CONSTRAINT `ArticleCodeScheme_categoryId_fkey`
    FOREIGN KEY (`categoryId`) REFERENCES `ArticleCodeCategory`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
