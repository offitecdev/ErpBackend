-- SCHALTSCHRANK-KENNUNG (20.09.2026, Vorgabe Baris) — Modell- und Seriennummer.
--
-- Nur NEUE Tabellen; keine bestehende Tabelle wird verändert:
--   uretim_pano_ayarlari    die acht offenen Entscheidungen als EINSTELLUNGEN
--   uretim_pano_tipleri     Typenfamilien (CP, DB, MCC …) + Einheit + Icw-Pflicht
--   uretim_pano_modelleri   das Modell: Produktkarte + Typenschild-Werte
--   uretim_pano_seri        EIN gebauter Schrank mit seiner Seriennummer
--
-- Die Seriennummern selbst zählt die vorhandene Tabelle `DocumentCounter`
-- (docType `PANEL_SERIAL:<jahr>` bzw. `PANEL_SERIAL_RETRO:<jahr>`) — derselbe
-- atomare Zähler wie AN/PR/AB/NT/RE, deshalb keine eigene Zählertabelle.
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_pano_ayarlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `manufacturerName` VARCHAR(120) NOT NULL DEFAULT 'OffiTec',
    `modelPrefix` VARCHAR(8) NOT NULL DEFAULT 'OT',
    `serialScope` VARCHAR(16) NOT NULL DEFAULT 'GROUP',
    `serialYearlyReset` BOOLEAN NOT NULL DEFAULT true,
    `serialDigits` INTEGER NOT NULL DEFAULT 6,
    `retroBlockStart` INTEGER NULL,
    `variantRules` JSON NULL,
    `defaultStandard` VARCHAR(80) NOT NULL DEFAULT 'SN EN IEC 61439-2',
    `defaultIpRating` VARCHAR(16) NULL,
    `defaultVoltage` DOUBLE NULL,
    `defaultPhases` INTEGER NULL DEFAULT 3,
    `defaultHz` DOUBLE NULL DEFAULT 50,
    `warrantyMonths` INTEGER NOT NULL DEFAULT 24,
    `labelWidthMm` DOUBLE NOT NULL DEFAULT 100,
    `labelHeightMm` DOUBLE NOT NULL DEFAULT 60,
    `labelMaterial` VARCHAR(80) NULL,
    `labelPrinter` VARCHAR(120) NULL,
    `labelQrBaseUrl` VARCHAR(200) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_pano_ayarlari_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_pano_tipleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(4) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `nameDe` VARCHAR(80) NULL,
    `ratingUnit` VARCHAR(8) NOT NULL DEFAULT 'KW',
    `requiresShortCircuit` BOOLEAN NOT NULL DEFAULT false,
    `codeSchemeId` VARCHAR(191) NULL,
    `standard` VARCHAR(80) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_pano_tipleri_tenantId_isActive_sortOrder_idx`(`tenantId`, `isActive`, `sortOrder`),
    UNIQUE INDEX `uretim_pano_tipleri_tenantId_code_key`(`tenantId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_pano_modelleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NOT NULL,
    `typeFamilyId` VARCHAR(191) NOT NULL,
    `typeCode` VARCHAR(4) NOT NULL,
    `ratingValue` INTEGER NOT NULL,
    `ratingUnit` VARCHAR(8) NOT NULL DEFAULT 'KW',
    `variantCode` VARCHAR(8) NULL,
    `modelNumber` VARCHAR(40) NOT NULL,
    `manufacturer` VARCHAR(120) NOT NULL DEFAULT 'OffiTec',
    `ratedVoltage` DOUBLE NULL,
    `ratedCurrent` DOUBLE NULL,
    `phaseCount` INTEGER NULL DEFAULT 3,
    `frequency` DOUBLE NULL DEFAULT 50,
    `shortCircuitIcw` DOUBLE NULL,
    `shortCircuitTime` DOUBLE NULL,
    `shortCircuitIpk` DOUBLE NULL,
    `ipRating` VARCHAR(16) NULL,
    `standard` VARCHAR(80) NULL,
    `ceMarking` BOOLEAN NOT NULL DEFAULT true,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_pano_modelleri_articleId_key`(`articleId`),
    INDEX `uretim_pano_modelleri_tenantId_isActive_idx`(`tenantId`, `isActive`),
    INDEX `uretim_pano_modelleri_typeFamilyId_idx`(`typeFamilyId`),
    UNIQUE INDEX `uretim_pano_modelleri_tenantId_modelNumber_key`(`tenantId`, `modelNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_pano_seri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `serialTenantId` VARCHAR(191) NOT NULL,
    `serialNumber` VARCHAR(32) NOT NULL,
    `serialYear` INTEGER NOT NULL,
    `serialSeq` INTEGER NOT NULL,
    `isRetro` BOOLEAN NOT NULL DEFAULT false,
    `panelModelId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NULL,
    `modelNumberSnapshot` VARCHAR(40) NULL,
    `nameplate` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
    `productionProjectId` VARCHAR(191) NULL,
    `productionItemId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NULL,
    `salesOrderId` VARCHAR(191) NULL,
    `orderNumber` VARCHAR(40) NULL,
    `customerId` VARCHAR(191) NULL,
    `customerName` VARCHAR(255) NULL,
    `siteName` VARCHAR(255) NULL,
    `schemaNumber` VARCHAR(60) NULL,
    `schemaRevision` VARCHAR(16) NULL,
    `schemaFileUrl` TEXT NULL,
    `manufacturedAt` DATETIME(3) NULL,
    `productionYear` INTEGER NULL,
    `testedAt` DATETIME(3) NULL,
    `testedById` VARCHAR(191) NULL,
    `labelPrintedAt` DATETIME(3) NULL,
    `labelPrintedById` VARCHAR(191) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `warrantyUntil` DATETIME(3) NULL,
    `stockMovementId` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_pano_seri_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
    INDEX `uretim_pano_seri_tenantId_panelModelId_idx`(`tenantId`, `panelModelId`),
    INDEX `uretim_pano_seri_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    INDEX `uretim_pano_seri_tenantId_projectId_idx`(`tenantId`, `projectId`),
    UNIQUE INDEX `uretim_pano_seri_serialTenantId_serialNumber_key`(`serialTenantId`, `serialNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `uretim_pano_modelleri` ADD CONSTRAINT `uretim_pano_modelleri_typeFamilyId_fkey` FOREIGN KEY (`typeFamilyId`) REFERENCES `uretim_pano_tipleri`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uretim_pano_seri` ADD CONSTRAINT `uretim_pano_seri_panelModelId_fkey` FOREIGN KEY (`panelModelId`) REFERENCES `uretim_pano_modelleri`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
