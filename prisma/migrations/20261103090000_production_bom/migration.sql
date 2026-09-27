-- BOM DER PRODUKTION (27.09.2026, Vorgabe Samet)
--
-- «Üretimde BOM Liste alanında … her bom için bom şablonları olur … bir
--  rezerve sistemi de olması lazım … ürün detayında minimum alış olmalı …
--  BOM tamamla.»
--
-- Nur HINZUGEFÜGT: sieben neue Tabellen und eine neue Spalte an der
-- Depo-Karte; nichts umbenannt, nichts gelöscht — ein älterer Stand des
-- Servers läuft gegen diese Datenbank unverändert weiter. Keine der neuen
-- Tabellen zeigt mit einem Fremdschlüssel nach aussen (Karte, Projekt,
-- Gerät, Bestellung und Personen stehen als blosse Kennung daneben):
--   uretim_bom_ayarlari          Höchstzahl BOM je Gerät und Bereich
--   uretim_bom_sablonlari        BOM-Vorlagen (Kategorie, Ana kart, Nummernvorsatz)
--   uretim_bom_sablon_satirlari  ihre Zeilen (Depo-Karte × Menge)
--   uretim_bomlari               die BOMs der Geräte
--   uretim_bom_satirlari         ihre Zeilen (Bedarf, abgebucht)
--   uretim_bom_siparisleri       Bestellung/Preisanfrage ↔ BOM (+ Angebots-PDF)
--   uretim_bom_tuketimleri       was «Stoktan düş» abgebucht hat
--   depo_urun_kartlari.minimumOrderQuantity   NEU  Mindestbestellmenge
--
-- Die BOM-Nummern zählen in `DocumentCounter` (docType «BOM:<Vorsatz>»).
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `depo_urun_kartlari` ADD COLUMN `minimumOrderQuantity` DECIMAL(14, 3) NULL AFTER `purchasePrice`;

-- CreateTable
CREATE TABLE `uretim_bom_ayarlari` (
    `tenantId` VARCHAR(191) NOT NULL,
    `maxPerArea` INTEGER NOT NULL DEFAULT 2,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`tenantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_sablonlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `category` VARCHAR(16) NOT NULL,
    `mainCard` VARCHAR(80) NOT NULL,
    `codePrefix` VARCHAR(24) NOT NULL,
    `description` TEXT NULL,
    `exampleKey` VARCHAR(40) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_bom_sablonlari_tenantId_deletedAt_idx`(`tenantId`, `deletedAt`),
    UNIQUE INDEX `uretim_bom_sablonlari_tenantId_exampleKey_key`(`tenantId`, `exampleKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_sablon_satirlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `erpCode` VARCHAR(64) NULL,
    `name` VARCHAR(255) NOT NULL,
    `brand` VARCHAR(120) NULL,
    `modelNumber` VARCHAR(120) NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `unit` VARCHAR(16) NULL,
    `note` VARCHAR(255) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `uretim_bom_sablon_satirlari_templateId_idx`(`templateId`),
    INDEX `uretim_bom_sablon_satirlari_tenantId_productId_idx`(`tenantId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bomlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(16) NOT NULL,
    `templateId` VARCHAR(191) NULL,
    `templateName` VARCHAR(160) NOT NULL,
    `mainCard` VARCHAR(80) NULL,
    `bomNumber` VARCHAR(40) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedById` VARCHAR(191) NULL,
    `completedAt` DATETIME(3) NULL,
    `completedById` VARCHAR(191) NULL,
    `consumedAt` DATETIME(3) NULL,
    `consumedById` VARCHAR(191) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_bomlari_tenantId_productionItemId_idx`(`tenantId`, `productionItemId`),
    INDEX `uretim_bomlari_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    INDEX `uretim_bomlari_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `uretim_bomlari_tenantId_bomNumber_key`(`tenantId`, `bomNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_satirlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `erpCode` VARCHAR(64) NULL,
    `name` VARCHAR(255) NOT NULL,
    `brand` VARCHAR(120) NULL,
    `modelNumber` VARCHAR(120) NULL,
    `unit` VARCHAR(16) NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `consumedQuantity` DECIMAL(14, 3) NOT NULL DEFAULT 0,
    `note` VARCHAR(255) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `uretim_bom_satirlari_bomId_idx`(`bomId`),
    INDEX `uretim_bom_satirlari_tenantId_productId_idx`(`tenantId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_siparisleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `sourcePurchaseOrderId` VARCHAR(191) NULL,
    `lines` JSON NULL,
    `quoteFileRef` VARCHAR(512) NULL,
    `quoteFileName` VARCHAR(255) NULL,
    `quoteFileType` VARCHAR(100) NULL,
    `quoteFileSize` INTEGER NULL,
    `quoteUploadedAt` DATETIME(3) NULL,
    `quoteUploadedById` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_bom_siparisleri_tenantId_bomId_idx`(`tenantId`, `bomId`),
    UNIQUE INDEX `uretim_bom_siparisleri_tenantId_purchaseOrderId_key`(`tenantId`, `purchaseOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_tuketimleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `lineId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `serialNumber` VARCHAR(128) NULL,
    `consumedById` VARCHAR(191) NULL,
    `consumedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `uretim_bom_tuketimleri_tenantId_bomId_idx`(`tenantId`, `bomId`),
    INDEX `uretim_bom_tuketimleri_tenantId_productId_idx`(`tenantId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `uretim_bom_sablon_satirlari` ADD CONSTRAINT `uretim_bom_sablon_satirlari_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `uretim_bom_sablonlari`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uretim_bom_satirlari` ADD CONSTRAINT `uretim_bom_satirlari_bomId_fkey` FOREIGN KEY (`bomId`) REFERENCES `uretim_bomlari`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
