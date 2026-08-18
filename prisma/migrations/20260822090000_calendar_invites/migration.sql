-- KALENDER-EINLADUNGEN (Vorgabe 18.08.2026).
--
-- Termine verlassen das ERP künftig als echte iCalendar-Anfrage
-- (text/calendar; method=REQUEST): der Empfänger trägt sie mit einem Klick in
-- Outlook ein, und eine Änderung ersetzt den Termin, statt einen zweiten
-- anzulegen. Dafür braucht jeder Termin eine UID, die über alle Änderungen
-- gleich bleibt, und einen Zählstand, der bei jeder Aktualisierung steigt —
-- ohne steigende SEQUENCE verwirft Outlook die Aktualisierung stillschweigend.
--
-- MeetingActivity bekommt zusätzlich die Herkunft: Termine, die AUS Outlook
-- hereinkommen (Einladung an das Firmenpostfach), werden über `icalUid`
-- wiedererkannt und aktualisiert statt doppelt angelegt.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `Appointment`
    ADD COLUMN `icalUid` VARCHAR(191) NULL,
    ADD COLUMN `icalSequence` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `inviteSentAt` DATETIME(3) NULL;

ALTER TABLE `MeetingActivity`
    ADD COLUMN `icalUid` VARCHAR(191) NULL,
    ADD COLUMN `icalSequence` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `inviteSentAt` DATETIME(3) NULL,
    ADD COLUMN `externalOrigin` VARCHAR(16) NULL,
    ADD COLUMN `externalOrganizer` VARCHAR(255) NULL;

CREATE INDEX `MeetingActivity_tenantId_icalUid_idx` ON `MeetingActivity`(`tenantId`, `icalUid`);
