-- GÖREVLENDİRME: GEWICHTE JE STUFE (30.09.2026)
--
-- «The weights of the task only should fill the weight of its stage, not the
--  other stages.» Jede Stufe trägt ein Gewicht im Bereich (in `sections`,
-- JSON — keine Spalte nötig), jede Aufgabe ein Gewicht in ihrer Stufe.
--
-- Nur HINZUGEFÜGT, damit ein älterer Stand des Servers gegen dieselbe
-- Datenbank weiterläuft: `weight` behält seine Bedeutung (Anteil am Bereich)
-- und wird weiter geschrieben; das Gewicht in der Stufe steht daneben. NULL =
-- von vorher — der Server leitet es aus `weight` ab.
--   uretim_gorev_sablon_gorevleri.stageWeight  NEU
--   uretim_cihaz_gorevleri.stageWeight         NEU
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_gorev_sablon_gorevleri` ADD COLUMN `stageWeight` DOUBLE NULL;

-- AlterTable
ALTER TABLE `uretim_cihaz_gorevleri` ADD COLUMN `stageWeight` DOUBLE NULL;
