-- BOM-REVISIONEN (27.09.2026, Vorgabe Samet)
--
-- «Bom onaylandıktan sonra artık sipariş verilirse eski bom artık kayıt
--  edilmeli ve yeni revizyon oluşturulmalı … bom onaylanırsa geri dönüş yok,
--  revize olması lazım.»
--
-- Nur HINZUGEFÜGT; nichts gelöscht, nichts umbenannt:
--   uretim_bomlari.revision                NEU  die geltende Revision (0 = erste Freigabe)
--   uretim_bom_siparisleri.bomRevision     NEU  für welche BOM-Revision der Beleg gilt
--   uretim_bom_siparisleri.orderRevision   NEU  wie oft eine Revision die Bestellung änderte
--   uretim_bom_revizyonlari                NEU  die Revisionen einer BOM (Zeilen, Grund, Unterschied)
--   uretim_bom_siparis_revizyonlari        NEU  eine Bestellung vor ihrer Revision (altes PDF, alte Bestätigung)
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_bomlari` ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `uretim_bom_siparisleri` ADD COLUMN `bomRevision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `orderRevision` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `uretim_bom_revizyonlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `reason` TEXT NULL,
    `lines` JSON NOT NULL,
    `changes` JSON NULL,
    `orderActions` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `approvedById` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_bom_revizyonlari_tenantId_bomId_idx`(`tenantId`, `bomId`),
    UNIQUE INDEX `uretim_bom_revizyonlari_tenantId_bomId_revision_key`(`tenantId`, `bomId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_bom_siparis_revizyonlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `bomId` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `bomRevision` INTEGER NOT NULL,
    `changes` JSON NOT NULL,
    `previousOrder` JSON NOT NULL,
    `previousStatus` VARCHAR(24) NOT NULL,
    `quoteFileRef` VARCHAR(512) NULL,
    `quoteFileName` VARCHAR(255) NULL,
    `quoteFileType` VARCHAR(100) NULL,
    `quoteFileSize` INTEGER NULL,
    `quoteUploadedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `uretim_bom_siparis_revizyonlari_tenantId_bomId_idx`(`tenantId`, `bomId`),
    UNIQUE INDEX `uretim_bom_siparis_rev_tenantId_purchaseOrderId_number_key`(`tenantId`, `purchaseOrderId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
