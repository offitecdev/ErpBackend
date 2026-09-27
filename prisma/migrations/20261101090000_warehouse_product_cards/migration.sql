-- DEPO (26.09.2026, Vorgabe Samet) — das eigene Lager der Produktionsfirma.
--
-- «Stok modülünü bozmuyoruz. Ek olarak depo modülü yazıyoruz.»
--
-- Nur NEUE Tabellen; keine bestehende Tabelle wird verändert, und keine der
-- neuen zeigt mit einem Fremdschlüssel auf eine bestehende (Lieferant,
-- Produktionsprojekt und -gerät stehen als blosse Kennung daneben):
--   depo_malzeme_gruplari  Materialgruppen (Filter der Produktkarten)
--   depo_urun_kartlari     die Produktkarten (Pflicht: nur der Name)
--   depo_seri_numaralari   Seriennummern einer Karte + Projekt / Gerät
--
-- Rechte: das Modul liest mit `production.view` und schreibt mit
-- `production.manage` — keine neuen Permission-Zeilen.
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `depo_malzeme_gruplari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `depo_malzeme_gruplari_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `depo_urun_kartlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `erpCode` VARCHAR(64) NULL,
    `materialGroupId` VARCHAR(191) NULL,
    `name` VARCHAR(255) NOT NULL,
    `brand` VARCHAR(120) NULL,
    `modelNumber` VARCHAR(120) NULL,
    `supplierId` VARCHAR(191) NULL,
    `supplierName` VARCHAR(191) NULL,
    `supplierNumber` VARCHAR(120) NULL,
    `description` TEXT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL DEFAULT 0,
    `purchasePrice` DECIMAL(14, 4) NULL,
    `currency` VARCHAR(3) NULL,
    `barcode` VARCHAR(128) NULL,
    `manufacturerBarcode` VARCHAR(128) NULL,
    `serialRequired` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `depo_urun_kartlari_tenantId_name_idx`(`tenantId`, `name`),
    INDEX `depo_urun_kartlari_tenantId_materialGroupId_idx`(`tenantId`, `materialGroupId`),
    INDEX `depo_urun_kartlari_tenantId_barcode_idx`(`tenantId`, `barcode`),
    INDEX `depo_urun_kartlari_tenantId_manufacturerBarcode_idx`(`tenantId`, `manufacturerBarcode`),
    UNIQUE INDEX `depo_urun_kartlari_tenantId_erpCode_key`(`tenantId`, `erpCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `depo_seri_numaralari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `serialNumber` VARCHAR(128) NOT NULL,
    `productionProjectId` VARCHAR(191) NULL,
    `productionItemId` VARCHAR(191) NULL,
    `projectNumber` VARCHAR(64) NULL,
    `projectName` VARCHAR(255) NULL,
    `deviceName` VARCHAR(500) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `depo_seri_numaralari_tenantId_serialNumber_idx`(`tenantId`, `serialNumber`),
    INDEX `depo_seri_numaralari_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    UNIQUE INDEX `depo_seri_numaralari_productId_serialNumber_key`(`productId`, `serialNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `depo_urun_kartlari` ADD CONSTRAINT `depo_urun_kartlari_materialGroupId_fkey` FOREIGN KEY (`materialGroupId`) REFERENCES `depo_malzeme_gruplari`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `depo_seri_numaralari` ADD CONSTRAINT `depo_seri_numaralari_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `depo_urun_kartlari`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
