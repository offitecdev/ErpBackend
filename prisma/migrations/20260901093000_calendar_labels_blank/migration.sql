-- KALENDER-ETIKETTEN: LEERE LISTE UND ROLLEN (25.08.2026, Vorgabe Samet).
--
-- Die Migration davor (20260901090000_calendar_labels) hat jedem Mandanten
-- sieben Etiketten angelegt und die Altbestaende darauf gesetzt. Vorgabe
-- danach: «zuerst eine leere Liste, nur ein Plus» -- die Namen und Farben
-- bestimmt der Betrieb selbst, nichts steht vorgegeben da.
--
-- Also: `systemKey` faellt weg und wird durch `role` ersetzt (APPOINTMENT |
-- MEETING -- wofuer das Etikett gedacht ist, wenn ein Eintrag dieser Art
-- angelegt wird), und der Erstbestand wird geloescht. Die Fremdschluessel der
-- drei Tabellen raeumen dabei selbst auf (ON DELETE SET NULL): kein Eintrag
-- geht verloren, sie stehen danach ohne Etikett -- was bei einer leeren Liste
-- auch der einzig richtige Zustand ist.
--
-- Apply with: npx prisma migrate deploy

DROP INDEX `CalendarLabel_tenantId_systemKey_key` ON `CalendarLabel`;

ALTER TABLE `CalendarLabel` DROP COLUMN `systemKey`;
ALTER TABLE `CalendarLabel` ADD COLUMN `role` VARCHAR(24) NULL;

CREATE INDEX `CalendarLabel_tenantId_role_idx` ON `CalendarLabel`(`tenantId`, `role`);

-- Die Liste faengt leer an. (Die Etiketten der Migration davor sind der
-- einzige Bestand, den es geben kann -- angelegt hat bis hierher niemand.)
DELETE FROM `CalendarLabel`;
