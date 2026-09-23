-- PRODUKTION (19.09.2026, Vorgabe Samet) — das Modul «Produktionsaufträge».
--
-- Nur NEUE Tabellen; keine bestehende Tabelle wird verändert:
--   uretim_sirket_aktarimlari  Einstellungen → Firmenübertragungen (Quellfirmen)
--   uretim_projeler            Produktionsprojekte (ERP-Projekt oder Lieferauftrag)
--   uretim_proje_siparisleri   ihre Aufträge (AB) und Nachträge (NT)
--   uretim_proje_kalemleri     Geräte und Leistungen (Verkaufspositionen)
--   uretim_siparis_atamalari   Lieferantenbestellung ↔ Projekt + Geräte
--   uretim_siparisleri         die Zeilen bestätigter Bestellungen
--
-- Dazu zwei Rechte (production.view / production.manage). Wer heute die
-- Lieferantenbestellungen sieht bzw. führt, bekommt sie — dieselbe Regel, die
-- PAGE_LEVEL_FALLBACKS für die Seitenstufen anwendet. Die Administratorrolle
-- bekommt beide.
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_sirket_aktarimlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `sourceTenantIds` JSON NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_sirket_aktarimlari_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_projeler` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `sourceTenantId` VARCHAR(191) NOT NULL,
    `sourceKey` VARCHAR(200) NOT NULL,
    `sourceKind` VARCHAR(16) NOT NULL,
    `sourceProjectId` VARCHAR(191) NULL,
    `sourceSalesOrderId` VARCHAR(191) NULL,
    `projectNumber` VARCHAR(191) NOT NULL,
    `projectName` VARCHAR(255) NOT NULL,
    `customerName` VARCHAR(255) NULL,
    `sourceStatus` VARCHAR(40) NULL,
    `salesTotal` DOUBLE NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `syncedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_projeler_tenantId_isActive_sourceKind_idx`(`tenantId`, `isActive`, `sourceKind`),
    UNIQUE INDEX `uretim_projeler_tenantId_sourceKey_key`(`tenantId`, `sourceKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_proje_siparisleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `sourceSalesOrderId` VARCHAR(191) NOT NULL,
    `parentSalesOrderId` VARCHAR(191) NULL,
    `orderNumber` VARCHAR(191) NOT NULL,
    `orderType` VARCHAR(40) NOT NULL,
    `orderKind` VARCHAR(16) NOT NULL,
    `orderDate` DATETIME(3) NULL,
    `status` VARCHAR(24) NOT NULL,
    `totalAmount` DOUBLE NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `syncedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_proje_siparisleri_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    UNIQUE INDEX `uretim_proje_siparisleri_tenantId_sourceSalesOrderId_key`(`tenantId`, `sourceSalesOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_proje_kalemleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionOrderId` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(20) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `positionNumber` VARCHAR(40) NULL,
    `name` VARCHAR(500) NOT NULL,
    `description` TEXT NULL,
    `articleId` VARCHAR(191) NULL,
    `articleCode` VARCHAR(191) NULL,
    `quantity` DOUBLE NOT NULL DEFAULT 0,
    `unit` VARCHAR(40) NULL,
    `unitPrice` DOUBLE NOT NULL DEFAULT 0,
    `totalPrice` DOUBLE NOT NULL DEFAULT 0,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `syncedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_proje_kalemleri_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    INDEX `uretim_proje_kalemleri_productionOrderId_idx`(`productionOrderId`),
    UNIQUE INDEX `uretim_proje_kalemleri_tenantId_sourceType_sourceId_key`(`tenantId`, `sourceType`, `sourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_siparis_atamalari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionItemIds` JSON NOT NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_siparis_atamalari_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    UNIQUE INDEX `uretim_siparis_atamalari_tenantId_purchaseOrderId_key`(`tenantId`, `purchaseOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_siparisleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `purchaseOrderNumber` VARCHAR(191) NOT NULL,
    `supplierName` VARCHAR(255) NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'CHF',
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NULL,
    `lineIndex` INTEGER NOT NULL,
    `articleId` VARCHAR(191) NULL,
    `code` VARCHAR(191) NULL,
    `name` VARCHAR(500) NOT NULL,
    `unit` VARCHAR(40) NULL,
    `quantity` DOUBLE NOT NULL DEFAULT 0,
    `grossPrice` DOUBLE NOT NULL DEFAULT 0,
    `discount` DOUBLE NOT NULL DEFAULT 0,
    `discount2` DOUBLE NOT NULL DEFAULT 0,
    `netPrice` DOUBLE NOT NULL DEFAULT 0,
    `lineTotal` DOUBLE NOT NULL DEFAULT 0,
    `receivedQuantity` DOUBLE NOT NULL DEFAULT 0,
    `approvedAt` DATETIME(3) NOT NULL,
    `approvedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_siparisleri_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    INDEX `uretim_siparisleri_tenantId_productionItemId_idx`(`tenantId`, `productionItemId`),
    INDEX `uretim_siparisleri_tenantId_approvedAt_idx`(`tenantId`, `approvedAt`),
    UNIQUE INDEX `uretim_siparisleri_purchaseOrderId_lineIndex_key`(`purchaseOrderId`, `lineIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `uretim_proje_siparisleri` ADD CONSTRAINT `uretim_proje_siparisleri_productionProjectId_fkey` FOREIGN KEY (`productionProjectId`) REFERENCES `uretim_projeler`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uretim_proje_kalemleri` ADD CONSTRAINT `uretim_proje_kalemleri_productionProjectId_fkey` FOREIGN KEY (`productionProjectId`) REFERENCES `uretim_projeler`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uretim_proje_kalemleri` ADD CONSTRAINT `uretim_proje_kalemleri_productionOrderId_fkey` FOREIGN KEY (`productionOrderId`) REFERENCES `uretim_proje_siparisleri`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Rechte ───────────────────────────────────────────────────────────────────
INSERT IGNORE INTO `Permission` (`id`, `permissionName`) VALUES
    ('prod_view', 'production.view'),
    ('prod_manage', 'production.manage');

-- Ansehen: wer das Lager sieht.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT DISTINCT rp.`roleId`, np.`id`
  FROM `RolePermission` rp
  JOIN `Permission` op ON op.`id` = rp.`permissionId` AND op.`permissionName` = 'inventory.view'
  JOIN `Permission` np ON np.`permissionName` = 'production.view';

-- Führen: wer Lieferantenbestellungen führt.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT DISTINCT rp.`roleId`, np.`id`
  FROM `RolePermission` rp
  JOIN `Permission` op ON op.`id` = rp.`permissionId` AND op.`permissionName` IN ('inventory.proposals.manage', 'inventory.manage')
  JOIN `Permission` np ON np.`permissionName` = 'production.manage';

-- Die Administratorrolle: beide.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, np.`id`
  FROM `Role` r
  JOIN `Permission` np ON np.`permissionName` IN ('production.view', 'production.manage')
 WHERE r.`isSystemAdmin` = true;
