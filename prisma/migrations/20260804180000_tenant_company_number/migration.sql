-- ŞİRKET NUMARASI ŞİRKETİN KENDİSİNE TAŞINDI
--
-- Belge kodundaki blok (AN-2026-**1**0001) şimdiye kadar şirket KATEGORİSİNDEN
-- (`ModuleProfile.profileNumber`) geliyordu. Kategori bir MODÜL PAKETİDİR: aynı
-- paketi paylaşan iki şirket zorunlu olarak aynı bloğa düşüyordu ve farklı
-- numara vermek için sırf numara uğruna kategori kopyalamak gerekiyordu.
--
-- Artık numara şirketin kendi alanıdır (`Tenant.companyNumber`) ve modül
-- paketinden BAĞIMSIZDIR: "Offitec GmbH" ile "Offitec Group AG" aynı
-- "1 - Genel" kategorisinde kalıp 1 ve 4 numaralarını taşıyabilir.
--
-- ⚠ MEVCUT BLOKLAR KORUNUR: numara, şirketin BUGÜNKÜ kategorisinin numarasından
-- doldurulur. Böylece bu geçişten sonra üretilen ilk belge, geçişten önce
-- alacağı numaranın aynısını alır — hiçbir şirketin serisi kaymaz.
--
-- Kategorisi olmayan şirket 0'da kalır (00001'den sayar).
--
-- Uygulama: npx prisma migrate deploy

ALTER TABLE `Tenant` ADD COLUMN `companyNumber` INT NOT NULL DEFAULT 0;

UPDATE `Tenant` `t`
JOIN `ModuleProfile` `mp` ON `mp`.`id` = `t`.`moduleProfileId`
SET `t`.`companyNumber` = `mp`.`profileNumber`
WHERE `t`.`companyNumber` = 0;
