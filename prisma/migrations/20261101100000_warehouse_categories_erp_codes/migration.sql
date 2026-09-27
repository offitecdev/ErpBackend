-- DEPO, zweiter Durchgang (26.09.2026, Vorgabe Samet): Hauptkategorien,
-- ERP-Codes je Materialgruppe, GS1-Barcode, Etikett und Excel-Aktarım mit
-- Freigabe durch die Verwaltung.
--
-- «Malzeme grupları … ilk başta ana kategori ekleme ve onun kısaltmasını
--  ekleme — Elektrik ELK … Malzeme grubuna göre ERP kodu oluşturulması
--  gerekiyor. ELK-PLC-00001 şeklinde … her ERP numarasına özel bir barkod
--  tanımlansın, GS1'e göre … her aktarımdan önce toplu aktarım
--  administratöre izin gitmesi lazım.»
--
-- Nur Tabellen des Depos (depo_*); das Artikellager (Article,
-- ArticleCodeScheme …) bleibt unberührt.
--
--   depo_ana_kategoriler    NEU  Hauptkategorien mit Kürzel
--   depo_malzeme_gruplari   + categoryId, code, lastNumber, sortOrder;
--                           eindeutig je Kategorie statt je Firma
--   depo_urun_kartlari      Barcode eindeutig je Firma (er zeigt auf genau
--                           eine Karte — bisher nur von der Anwendung geprüft)
--   depo_ayarlar            NEU  Barcodezähler + Etikett je Firma
--   depo_aktarimlar         NEU  Excel-Aktarımlar mit Freigabe
--
-- Altbestand: Gruppen aus der Zeit vor den Kategorien kommen je Firma in die
-- Kategorie «Genel» (GEN); ihr Kürzel bleibt leer, bis es gesetzt wird.
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `depo_ana_kategoriler` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(8) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `depo_ana_kategoriler_tenantId_code_key`(`tenantId`, `code`),
    UNIQUE INDEX `depo_ana_kategoriler_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Altbestand: eine Kategorie «Genel» je Firma, die schon Gruppen hat.
INSERT INTO `depo_ana_kategoriler` (`id`, `tenantId`, `name`, `code`, `sortOrder`, `createdAt`, `updatedAt`)
SELECT CONCAT('depo-gen-', LEFT(SHA2(`tenantId`, 256), 12)), `tenantId`, 'Genel', 'GEN', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
  FROM `depo_malzeme_gruplari`
 GROUP BY `tenantId`;

-- AlterTable (erst ohne Pflicht, damit der Altbestand eingeordnet werden kann)
ALTER TABLE `depo_malzeme_gruplari` ADD COLUMN `categoryId` VARCHAR(191) NULL,
    ADD COLUMN `code` VARCHAR(8) NULL,
    ADD COLUMN `lastNumber` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

UPDATE `depo_malzeme_gruplari`
   SET `categoryId` = CONCAT('depo-gen-', LEFT(SHA2(`tenantId`, 256), 12))
 WHERE `categoryId` IS NULL;

ALTER TABLE `depo_malzeme_gruplari` MODIFY `categoryId` VARCHAR(191) NOT NULL;

-- DropIndex / CreateIndex: Gruppennamen sind je Kategorie eindeutig.
DROP INDEX `depo_malzeme_gruplari_tenantId_name_key` ON `depo_malzeme_gruplari`;

CREATE INDEX `depo_malzeme_gruplari_tenantId_categoryId_idx` ON `depo_malzeme_gruplari`(`tenantId`, `categoryId`);

CREATE UNIQUE INDEX `depo_malzeme_gruplari_categoryId_name_key` ON `depo_malzeme_gruplari`(`categoryId`, `name`);

CREATE UNIQUE INDEX `depo_malzeme_gruplari_categoryId_code_key` ON `depo_malzeme_gruplari`(`categoryId`, `code`);

-- AddForeignKey
ALTER TABLE `depo_malzeme_gruplari` ADD CONSTRAINT `depo_malzeme_gruplari_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `depo_ana_kategoriler`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropIndex / CreateIndex: unser Barcode zeigt auf genau eine Karte.
DROP INDEX `depo_urun_kartlari_tenantId_barcode_idx` ON `depo_urun_kartlari`;

CREATE UNIQUE INDEX `depo_urun_kartlari_tenantId_barcode_key` ON `depo_urun_kartlari`(`tenantId`, `barcode`);

-- CreateTable
CREATE TABLE `depo_ayarlar` (
    `tenantId` VARCHAR(191) NOT NULL,
    `barcodeLastNumber` BIGINT NOT NULL DEFAULT 0,
    `labelSettings` JSON NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`tenantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `depo_aktarimlar` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `fileName` VARCHAR(255) NULL,
    `rowCount` INTEGER NOT NULL,
    `rows` JSON NOT NULL,
    `requestedById` VARCHAR(191) NULL,
    `requestedByName` VARCHAR(191) NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedByName` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `note` VARCHAR(500) NULL,
    `result` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `depo_aktarimlar_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
    INDEX `depo_aktarimlar_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
