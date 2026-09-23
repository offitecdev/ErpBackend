-- FİYAT TALEBİ ve SİPARİŞ AYRI KOD SERİLERİ (Samet, 21.09.2026).
--
-- Bir satın alma kaydı iki belge doğurur; artık her birinin kendi kodu vardır.
-- Depoda ALMANCA yazım durur — `PA-2026-001` (Preisanfrage) ve `BE-2026-001`
-- (Bestellung); ekranda/PDF'te dile göre önek değişir (tr FT/SP, en PR/PO),
-- yıl ve sıra hiç değişmez. `referenceNumber` GÜNCEL belgenin kodu olarak
-- kalır, böylece tüm uygulama (mail, PDF, üretim bağı, arama) onu okumayı
-- sürdürür.
ALTER TABLE `PurchaseOrder`
    ADD COLUMN `priceRequestNumber` VARCHAR(191) NULL AFTER `referenceNumber`,
    ADD COLUMN `orderNumber` VARCHAR(191) NULL AFTER `priceRequestNumber`;

-- Sipariş aşamasındaki (ve ötesindeki) kayıtlar kodlarını olduğu gibi tutar:
-- BE- zaten sipariş yazımıdır, eski AU- kayıtları da sipariş sayılır.
UPDATE `PurchaseOrder`
   SET `orderNumber` = `referenceNumber`
 WHERE `status` NOT IN ('DRAFT', 'PRICE_REQUEST');

-- FİYAT TALEBİ AŞAMASINDAKİ KAYITLAR PA- SERİSİNE TAŞINIR: yalnızca önek
-- değişir, sıra kuyruğu (`-2026-003`) korunur. Çakışma olamaz — bugüne kadar
-- hiçbir kayıt PA- ile başlamıyordu.
UPDATE `PurchaseOrder`
   SET `priceRequestNumber` = CONCAT('PA', SUBSTRING(`referenceNumber`, 3)),
       `referenceNumber` = CONCAT('PA', SUBSTRING(`referenceNumber`, 3))
 WHERE `status` IN ('DRAFT', 'PRICE_REQUEST')
   AND (`referenceNumber` LIKE 'BE-%' OR `referenceNumber` LIKE 'AU-%');

-- Elle girilmiş (tanınmayan) kodlu talepler dokunulmadan kalır; kodları
-- kendi kayıtlarının talep kodu sayılır.
UPDATE `PurchaseOrder`
   SET `priceRequestNumber` = `referenceNumber`
 WHERE `status` IN ('DRAFT', 'PRICE_REQUEST')
   AND `priceRequestNumber` IS NULL;
