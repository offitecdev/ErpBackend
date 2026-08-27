-- OSP (05.09.2026): Verkaeufer:in UND Projektleiter:in werden direkt gewaehlt.
-- Bisher trug die Zeile EINE Person mit umschaltbarer Rolle (salespersonRole);
-- jetzt hat jede Rolle ihre eigene Spalte.
ALTER TABLE `OspDocument`
    ADD COLUMN `projectManagerId` VARCHAR(191) NULL,
    ADD COLUMN `projectManagerEmail` VARCHAR(191) NULL,
    ADD COLUMN `projectManagerName` VARCHAR(191) NULL;

-- Wer als PROJECT_MANAGER eingetragen war, zieht in die neuen Spalten um; der
-- Verkaufsplatz der Zeile wird frei (die OSP bekommt nur Verkaeufer gemeldet).
UPDATE `OspDocument`
   SET `projectManagerId` = `salespersonId`,
       `projectManagerEmail` = `salespersonEmail`,
       `projectManagerName` = `salespersonName`,
       `salespersonId` = NULL,
       `salespersonEmail` = NULL,
       `salespersonName` = NULL
 WHERE `salespersonRole` = 'PROJECT_MANAGER'
   AND `salespersonId` IS NOT NULL;
