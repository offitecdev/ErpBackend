-- GÖREVLENDİRME: STAND EINER AUFGABE AM GERÄT (28.09.2026)
--
-- «The stage card should look like tables: code, name, weight and overall
--  contribution, status: to do, in progress, done, people.»
--
-- Der Stand gehört zur Arbeit am Gerät, nicht zur Vorlage. Nur HINZUGEFÜGT;
-- bestehende Aufgaben stehen danach auf TODO:
--   uretim_cihaz_gorevleri.status  NEU  TODO | IN_PROGRESS | DONE
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_cihaz_gorevleri` ADD COLUMN `status` VARCHAR(12) NOT NULL DEFAULT 'TODO';
