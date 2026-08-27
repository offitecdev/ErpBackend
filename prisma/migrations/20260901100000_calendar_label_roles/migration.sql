-- KALENDER-ETIKETTEN: FERTIG EINGERICHTET STATT LEER (25.08.2026, Vorgabe
-- Samet: «die Etiketten sollen von Anfang an richtig dastehen -- je Farbe ein
-- bestimmter Eintrag: geplanter Termin, laufender Termin, abgeschlossener
-- Termin, Besprechung»).
--
-- Drei Aenderungen:
--   1. Die Rollen sind jetzt vier statt zwei. APPOINTMENT zerfaellt in die drei
--      Staende eines Termins (PLANNED | ONGOING | DONE), MEETING bleibt.
--   2. `hidden` -- weggeraeumt, aber nicht weggeworfen. Ein ausgeblendetes
--      Etikett verschwindet aus Leiste und Auswahlfeld, die Eintraege behalten
--      es, und ueber das «+» kommt es zurueck (seine Rolle ist dann frei).
--   3. Je Mandant EIN Etikett pro Rolle, mit der Farbe, die die Karten dieses
--      Standes bisher schon trugen -- der Kalender sieht damit aus wie vorher,
--      nur ist die Farbe jetzt gewaehlt und nicht mehr aus der Uhr abgeleitet.
--
-- Angelegt wird nur, was FEHLT: die Kennung ist aus Mandant und Rolle gebaut
-- und damit wiederholbar, und ein Mandant, der seine Etiketten schon selbst
-- benannt hat, behaelt sie unveraendert.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `CalendarLabel` ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false;

DROP INDEX `CalendarLabel_tenantId_role_idx` ON `CalendarLabel`;
CREATE INDEX `CalendarLabel_tenantId_hidden_role_idx` ON `CalendarLabel`(`tenantId`, `hidden`, `role`);

-- Die alte Sammelrolle wird zum geplanten Termin -- das ist der Stand, in dem
-- ein Termin angelegt wird, und genau dafuer wurde sie benutzt.
UPDATE `CalendarLabel` SET `role` = 'PLANNED' WHERE `role` = 'APPOINTMENT';

INSERT IGNORE INTO `CalendarLabel`
    (`id`, `tenantId`, `name`, `color`, `sortOrder`, `role`, `hidden`, `createdAt`, `updatedAt`)
SELECT
    CONCAT('cl-', LEFT(MD5(CONCAT(t.`id`, '|', s.`role`)), 16)),
    t.`id`, s.`name`, s.`color`, s.`sortOrder`, s.`role`, false, NOW(3), NOW(3)
FROM `Tenant` t
CROSS JOIN (
              SELECT 'PLANNED' AS `role`, 'Geplanter Termin'        AS `name`, '#039be5' AS `color`, 10 AS `sortOrder`
    UNION ALL SELECT 'ONGOING',            'Laufender Termin',                 '#3f51b5',            20
    UNION ALL SELECT 'DONE',               'Abgeschlossener Termin',           '#0b8043',            30
    UNION ALL SELECT 'MEETING',            'Besprechung',                      '#8e24aa',            40
) s
-- Nur, wo diese Rolle beim Mandanten noch gar nicht vorkommt. Wer sein
-- «Geplanter Termin» laengst in «Offen» umbenannt hat, bekommt kein zweites.
WHERE NOT EXISTS (
    SELECT 1 FROM `CalendarLabel` c WHERE c.`tenantId` = t.`id` AND c.`role` = s.`role`
);
