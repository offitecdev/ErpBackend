-- DEPO, vierter Durchgang (26.09.2026, Vorgabe Samet): jeder Lieferant einer
-- Produktkarte trägt SEINEN Barcode des Produkts.
--
-- «Bu tedarikçi ürün kodu değil aslında bu ürün barkodu olması lazım —
--  tedarikçiye göre ürün barkodu … üretici barkodlarını her tedarikçiye özel
--  olarak okuması gerekiyor.»
--
-- Nur Tabellen des Depos, nur HINZUGEFÜGT (nichts umbenannt, nichts
-- gelöscht) — ein älterer Stand des Servers läuft gegen diese Datenbank
-- unverändert weiter.
--
--   depo_urun_tedarikcileri.barcode   NEU  Barcode je Lieferant (+ Index für den Scan)
--
-- Die bisherige «Tedarikçi ürün kodu» (supplierNumber) war nach Samet schon
-- der Barcode dieses Lieferanten: ihr Wert wird übernommen. supplierNumber
-- (auch der Abzug auf der Karte) wird ab jetzt nicht mehr beschrieben.
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `depo_urun_tedarikcileri` ADD COLUMN `barcode` VARCHAR(128) NULL AFTER `supplierName`;

-- CreateIndex
CREATE INDEX `depo_urun_tedarikcileri_tenantId_barcode_idx` ON `depo_urun_tedarikcileri`(`tenantId`, `barcode`);

-- Altbestand: die Produktnummer des Lieferanten wird sein Barcode.
UPDATE `depo_urun_tedarikcileri`
   SET `barcode` = TRIM(`supplierNumber`)
 WHERE `barcode` IS NULL
   AND `supplierNumber` IS NOT NULL
   AND TRIM(`supplierNumber`) <> '';
