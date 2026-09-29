-- GÖREVLENDİRME: ANGELEGT AM (28.09.2026)
--
-- «The dates should be on their columns: created at, start date (default is
--  the created at), due date.»
--
-- Speichern einer Vorlage schreibt ihre Aufgaben neu; der Tag, an dem eine
-- Aufgabe angelegt wurde, braucht darum eine eigene Spalte. Bestehende
-- Aufgaben bekommen den Tag ihrer Vorlage.
--   uretim_gorev_sablon_gorevleri.createdAt  NEU  Tag des Anlegens
-- (Die Aufgaben am Gerät haben ihren Zeitpunkt schon: den des Ladens.)
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_gorev_sablon_gorevleri` ADD COLUMN `createdAt` DATE NULL;

-- Backfill
UPDATE `uretim_gorev_sablon_gorevleri` AS t
  JOIN `uretim_gorev_sablonlari` AS s ON s.`id` = t.`templateId`
   SET t.`createdAt` = DATE(s.`createdAt`)
 WHERE t.`createdAt` IS NULL;
