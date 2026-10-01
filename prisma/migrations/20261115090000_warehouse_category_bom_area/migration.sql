-- DEPO › AYARLAR › KOD TÜRÜ → BOM ALANI (01.10.2026, Vorgabe Samet)
--
-- «Bomda mekanik olan sadece kendi MAK kodlarını görebilecek. Her kod türü,
--  bu kod türlerine de alan atama olacak: mekanik, elektrik ve ikisi de …
--  bomda ona göre gösterilecek, malzeme aratılıyor ya.»
--
-- Nur HINZUGEFÜGT — ein älterer Stand des Servers läuft unverändert weiter.
--
--   depo_ana_kategoriler.bomArea  NEU  MECHANICAL | ELECTRICAL | BOTH
--
-- Vorbelegung: MAK = Mekanik, ELK = Elektrik, alles andere (ORT …) = beide.
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `depo_ana_kategoriler`
    ADD COLUMN `bomArea` VARCHAR(16) NOT NULL DEFAULT 'BOTH' AFTER `code`;

UPDATE `depo_ana_kategoriler` SET `bomArea` = 'MECHANICAL' WHERE `code` = 'MAK';
UPDATE `depo_ana_kategoriler` SET `bomArea` = 'ELECTRICAL' WHERE `code` = 'ELK';
