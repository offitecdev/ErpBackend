-- OSP (07.09.2026): das ECHTE Datenblatt-PDF der Einheit.
-- Die OSP nennt im Webhook die Adresse der Datei; wir holen sie einmal, legen
-- sie bei uns ab und lesen die Angaben der Einheit daraus. Zusaetzlich wird der
-- unveraenderte Webhook-Eintrag mitgeschrieben - die OSP liefert mehr Felder,
-- als der Vertrag beschreibt.
ALTER TABLE `OspDocument`
    ADD COLUMN `datasheetUrl` TEXT NULL,
    ADD COLUMN `datasheetFile` VARCHAR(191) NULL,
    ADD COLUMN `datasheetFetchedAt` DATETIME(3) NULL,
    ADD COLUMN `datasheetError` TEXT NULL,
    ADD COLUMN `datasheetSpecs` JSON NULL,
    ADD COLUMN `rawPayload` JSON NULL;
