-- GÖREVLENDİRME DER PRODUKTION (26.09.2026, Vorgabe Samet)
--
-- «Üretimde yeni sayfa: görevlendirme şablonları … administrator isek
--  görevleri yükleyebiliyoruz.»
--
-- Nur NEUE Tabellen; keine bestehende Tabelle wird verändert, und keine der
-- neuen zeigt mit einem Fremdschlüssel auf eine bestehende (Gerät, Projekt
-- und Personen stehen als blosse Kennung daneben, wie bei uretim_*/depo_*):
--   uretim_gorev_sablonlari        Vorlagen (Chiller …) mit Bereichsanteilen
--   uretim_gorev_sablon_gorevleri  ihre Aufgaben (Bereich, Stufe, Gewicht, Personen)
--   uretim_cihaz_gorev_planlari    je Gerät die geladene Vorlage (Kopie)
--   uretim_cihaz_gorevleri         die Aufgaben des Geräts und ihre Personen
--
-- Rechte: lesen mit `production.view`, schreiben nur die Administratorrolle
-- (Role.isSystemAdmin) — keine neuen Permission-Zeilen.
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_gorev_sablonlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `areaShares` JSON NOT NULL,
    `exampleKey` VARCHAR(40) NULL,
    `createdById` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_gorev_sablonlari_tenantId_deletedAt_idx`(`tenantId`, `deletedAt`),
    UNIQUE INDEX `uretim_gorev_sablonlari_tenantId_exampleKey_key`(`tenantId`, `exampleKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_gorev_sablon_gorevleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(16) NOT NULL,
    `stage` VARCHAR(24) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `weight` DOUBLE NOT NULL,
    `assigneeIds` JSON NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `uretim_gorev_sablon_gorevleri_templateId_idx`(`templateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_cihaz_gorev_planlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionProjectId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NULL,
    `templateName` VARCHAR(120) NOT NULL,
    `areaShares` JSON NOT NULL,
    `loadedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_cihaz_gorev_planlari_tenantId_productionProjectId_idx`(`tenantId`, `productionProjectId`),
    UNIQUE INDEX `uretim_cihaz_gorev_planlari_tenantId_productionItemId_key`(`tenantId`, `productionItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_cihaz_gorevleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(16) NOT NULL,
    `stage` VARCHAR(24) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `weight` DOUBLE NOT NULL,
    `assigneeIds` JSON NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `uretim_cihaz_gorevleri_planId_idx`(`planId`),
    INDEX `uretim_cihaz_gorevleri_tenantId_productionItemId_idx`(`tenantId`, `productionItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `uretim_gorev_sablon_gorevleri` ADD CONSTRAINT `uretim_gorev_sablon_gorevleri_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `uretim_gorev_sablonlari`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uretim_cihaz_gorevleri` ADD CONSTRAINT `uretim_cihaz_gorevleri_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `uretim_cihaz_gorev_planlari`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

