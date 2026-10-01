-- DEPO › TEDARİKÇİ ÜRÜN NO. + SİPARİŞ NO. (01.10.2026, Vorgabe Samet)
--
-- «Ürün kartlarına her tedarikçiye özel malların yanına ürün numarası ve
--  sipariş numarası … fiyat taleplerine ve siparişlere de bu sütunlar
--  eklenmeli, otomatik şablonlarla da.»
--
-- Nur HINZUGEFÜGT — ein älterer Stand des Servers läuft unverändert weiter.
--
--   depo_urun_tedarikcileri.articleNumber  NEU  Artikelnummer des Lieferanten
--   depo_urun_tedarikcileri.orderNumber    NEU  Bestellnummer des Lieferanten
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `depo_urun_tedarikcileri`
    ADD COLUMN `articleNumber` VARCHAR(120) NULL AFTER `email`,
    ADD COLUMN `orderNumber` VARCHAR(120) NULL AFTER `articleNumber`;
