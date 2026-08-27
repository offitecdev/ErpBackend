-- KEIN «OHNE ETIKETT» MEHR (25.08.2026, Vorgabe Samet: «eine Zeile ‹ohne
-- Etikett› soll es nicht geben -- am Anfang sind sie alle EINE Farbe»).
--
-- Bis hierher trugen die Altbestaende gar kein Etikett und sammelten sich in
-- einer grauen Zeile «Ohne Etikett» in der Leiste. Die faellt weg -- und damit
-- muss JEDER Eintrag eines haben. Er bekommt es hier: jeder Termin das Etikett
-- der Rolle PLANNED, jede Besprechung das der Rolle MEETING. Die Termine sind
-- damit am Anfang alle EINE Farbe, und wer einen davon als laufend oder
-- abgeschlossen kennzeichnen will, waehlt das Etikett von Hand -- der Kalender
-- rechnet nichts mehr aus der Uhr.
--
-- Nur, was noch KEINES hat: wer schon von Hand etikettiert hat, behaelt seine
-- Wahl.
--
-- Apply with: npx prisma migrate deploy

UPDATE `Appointment` a
JOIN `CalendarLabel` l ON l.`tenantId` = a.`tenantId` AND l.`role` = 'PLANNED' AND l.`hidden` = false
SET a.`labelId` = l.`id`
WHERE a.`labelId` IS NULL;

UPDATE `MeetingActivity` m
JOIN `CalendarLabel` l ON l.`tenantId` = m.`tenantId` AND l.`role` = 'MEETING' AND l.`hidden` = false
SET m.`labelId` = l.`id`
WHERE m.`labelId` IS NULL AND m.`kind` <> 'TASK';
