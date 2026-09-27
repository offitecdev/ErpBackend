-- DEPO, dritter Durchgang (26.09.2026, Vorgabe Samet): mehrere Lieferanten
-- je Produktkarte, jeder mit seiner Produktnummer daneben.
--
-- «Bir ürün kartında birden fazla tedarikçi olabilir; ürün kodları
--  tedarikçilerin yanında olması gerekir.»
--
-- Nur Tabellen des Depos; das Artikellager bleibt unberührt.
--
--   depo_urun_tedarikcileri  NEU  Lieferanten einer Karte (+ Nummer, Reihenfolge)
--
-- Die bisherigen Spalten supplierId/supplierName/supplierNumber der Karte
-- bleiben und tragen künftig den ERSTEN Lieferanten der Liste (Abzug für
-- Liste, Sortierung und Export). Der Lieferant, den jede Karte bisher hatte,
-- wird als erste Zeile übernommen.
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `depo_urun_tedarikcileri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `supplierId` VARCHAR(191) NULL,
    `supplierName` VARCHAR(191) NOT NULL,
    `supplierNumber` VARCHAR(120) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `depo_urun_tedarikcileri_tenantId_supplierName_idx`(`tenantId`, `supplierName`),
    UNIQUE INDEX `depo_urun_tedarikcileri_productId_supplierName_key`(`productId`, `supplierName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `depo_urun_tedarikcileri` ADD CONSTRAINT `depo_urun_tedarikcileri_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `depo_urun_kartlari`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Altbestand: der eine Lieferant jeder Karte wird die erste Zeile der Liste.
INSERT INTO `depo_urun_tedarikcileri` (`id`, `tenantId`, `productId`, `supplierId`, `supplierName`, `supplierNumber`, `sortOrder`, `createdAt`, `updatedAt`)
SELECT CONCAT('dts-', LEFT(SHA2(p.`id`, 256), 16)), p.`tenantId`, p.`id`, p.`supplierId`, TRIM(p.`supplierName`), p.`supplierNumber`, 0,
       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
  FROM `depo_urun_kartlari` p
 WHERE p.`supplierName` IS NOT NULL AND TRIM(p.`supplierName`) <> '';
