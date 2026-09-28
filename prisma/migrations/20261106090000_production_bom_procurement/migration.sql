-- SATIN ALMA TALEBİ + GELEN MALLAR (27.09.2026 abends, Vorgabe Samet)
--
-- «Fiyat talepleri ve siparişleri muhasebe ve yöneticiler yapacak … bom'da
--  sadece sipariş ve fiyat talep istekleri oluşsun … başka bir sayfada talep
--  olarak gelsin.» — «Mal kabulde … en erken teslim tarihli projeye …
--  gelen mallara eklenmesi lazım.»
--
-- Nur HINZUGEFÜGT; nichts gelöscht, nichts umbenannt:
--   uretim_bom_talepleri      NEU  Talep der BOM (PRICE/ORDER) ohne Lieferant und Preis
--   uretim_bom_gelen_mallar   NEU  wohin eingegangene Ware bei der Buchung ging
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_bom_talepleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `requestNumber` VARCHAR(32) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(16) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `bomRevision` INTEGER NOT NULL DEFAULT 0,
    `lines` JSON NOT NULL,
    `note` TEXT NULL,
    `purchaseOrderIds` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `closedById` VARCHAR(191) NULL,
    `closedAt` DATETIME(3) NULL,

    INDEX `uretim_bom_talepleri_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `uretim_bom_talepleri_tenantId_bomId_idx`(`tenantId`, `bomId`),
    UNIQUE INDEX `uretim_bom_talepleri_tenantId_requestNumber_key`(`tenantId`, `requestNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_gelen_mallar` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `receiptId` VARCHAR(32) NOT NULL,
    `source` VARCHAR(12) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NULL,
    `referenceNumber` VARCHAR(40) NULL,
    `productId` VARCHAR(191) NOT NULL,
    `erpCode` VARCHAR(64) NULL,
    `name` VARCHAR(255) NOT NULL,
    `bomId` VARCHAR(191) NULL,
    `lineId` VARCHAR(191) NULL,
    `productionProjectId` VARCHAR(191) NULL,
    `productionItemId` VARCHAR(191) NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `serials` JSON NULL,
    `receivedById` VARCHAR(191) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `uretim_bom_gelen_mallar_tenantId_bomId_idx`(`tenantId`, `bomId`),
    INDEX `uretim_bom_gelen_mallar_tenantId_receivedAt_idx`(`tenantId`, `receivedAt`),
    INDEX `uretim_bom_gelen_mallar_tenantId_productId_idx`(`tenantId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
