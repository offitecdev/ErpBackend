-- GÖREVLENDİRME: BEGINN UND TERMIN (28.09.2026)
--
-- «Each task and subtask should have starting date and due date. But the
--  subtask's due date can't be further than its parent's due date, and the
--  start date can't be older than its parent's starting date.»
--
-- Nur HINZUGEFÜGT; nichts gelöscht, nichts umbenannt, keine Zeile verändert:
--   uretim_gorev_sablon_gorevleri.startDate / dueDate  NEU  Beginn und Termin einer Aufgabe der Vorlage
--   uretim_cihaz_gorevleri.startDate / dueDate         NEU  dieselben Tage, beim Laden kopiert
-- Die Tage der Unteraufgaben stehen in deren JSON (`subtasks`).
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_gorev_sablon_gorevleri` ADD COLUMN `startDate` DATE NULL,
    ADD COLUMN `dueDate` DATE NULL;

-- AlterTable
ALTER TABLE `uretim_cihaz_gorevleri` ADD COLUMN `startDate` DATE NULL,
    ADD COLUMN `dueDate` DATE NULL;
