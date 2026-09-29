-- GÖREVLENDİRME: EIGENE BEREICHE, STUFEN UND UNTERAUFGABEN (28.09.2026)
--
-- «When the user creates new template they should create the sections
--  manually, but keep the existing templates … also stages should be created
--  dynamically … each task can have multiple subtasks … on each subtask two
--  checkboxes (required fields: Document, Approval).»
--
-- Nur HINZUGEFÜGT; nichts gelöscht, nichts umbenannt, keine Zeile verändert:
--   uretim_gorev_sablonlari.sections        NEU  Bereiche + Stufen der Vorlage (NULL = Mekanik/Elektrik wie bisher)
--   uretim_gorev_sablon_gorevleri.subtasks  NEU  Unteraufgaben einer Aufgabe (NULL = keine)
--   uretim_cihaz_gorev_planlari.sections    NEU  Bereiche + Stufen beim Laden — der Weg des Geräts (NULL = wie bisher)
--   uretim_cihaz_gorevleri.subtasks         NEU  Unteraufgaben, aus der Vorlage kopiert (NULL = keine)
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_gorev_sablonlari` ADD COLUMN `sections` JSON NULL;

-- AlterTable
ALTER TABLE `uretim_gorev_sablon_gorevleri` ADD COLUMN `subtasks` JSON NULL;

-- AlterTable
ALTER TABLE `uretim_cihaz_gorev_planlari` ADD COLUMN `sections` JSON NULL;

-- AlterTable
ALTER TABLE `uretim_cihaz_gorevleri` ADD COLUMN `subtasks` JSON NULL;
