-- KALENDER-ETIKETTEN (25.08.2026, Vorgabe Samet).
--
-- Bis hierher stand die Farbe einer Kalenderkarte NICHT zur Wahl: der Kalender
-- las die Uhr und faerbte danach -- was bevorsteht blau, was laeuft indigo, was
-- vorbei ist gruen. Vorgabe: das Etikett wird GEWAEHLT. «Geplanter Termin»,
-- «Laufender Termin», «Vergangener Termin», «Besprechung», «Wartung»,
-- «Aufgabe» und «Offener Termin» sind darum ganz gewoehnliche Etiketten in
-- EINER Reihe -- keine Unterpunkte eines Termins --, jedes umbenennbar,
-- umfaerbbar und loeschbar; eigene kommen einfach dazu.
--
-- Der Erstbestand (derselbe wie in src/shared/calendarLabels.ts) wird jedem
-- bestehenden Mandanten angelegt; ein NEU angelegter Mandant bekommt ihn beim
-- ersten Aufruf der Liste. Danach werden die Altbestaende nachbesetzt: ein
-- Termin bekommt das Etikett, das seinem bisherigen abgeleiteten Stand
-- entspricht (das ist der Zustand, den der Kalender heute zeigt), eine
-- Besprechung «Besprechung», eine Aufgabe «Aufgabe». Ohne das stuenden alle
-- bestehenden Eintraege ploetzlich ohne Etikett da.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `CalendarLabel` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `color` VARCHAR(9) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `systemKey` VARCHAR(24) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CalendarLabel_tenantId_systemKey_key`(`tenantId`, `systemKey`),
    INDEX `CalendarLabel_tenantId_sortOrder_idx`(`tenantId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Erstbestand je Mandant. Die Kennung ist aus Mandant + Schluessel gebaut und
-- damit wiederholbar -- die Migration kann nicht doppelt anlegen.
INSERT IGNORE INTO `CalendarLabel`
    (`id`, `tenantId`, `name`, `color`, `sortOrder`, `systemKey`, `createdAt`, `updatedAt`)
SELECT
    CONCAT('cl-', LEFT(MD5(CONCAT(t.`id`, '|', s.`systemKey`)), 16)),
    t.`id`, s.`name`, s.`color`, s.`sortOrder`, s.`systemKey`, NOW(3), NOW(3)
FROM `Tenant` t
CROSS JOIN (
              SELECT 'PLANNED'     AS `systemKey`, 'Geplanter Termin'   AS `name`, '#039be5' AS `color`, 10 AS `sortOrder`
    UNION ALL SELECT 'ONGOING',                    'Laufender Termin',            '#3f51b5',            20
    UNION ALL SELECT 'PAST',                       'Vergangener Termin',          '#0b8043',            30
    UNION ALL SELECT 'MEETING',                    'Besprechung',                 '#8e24aa',            40
    UNION ALL SELECT 'MAINTENANCE',                'Wartung',                     '#f4511e',            50
    UNION ALL SELECT 'TASK',                       'Aufgabe',                     '#33b679',            60
    UNION ALL SELECT 'OPEN',                       'Offener Termin',              '#d93025',            70
) s;

-- ---------------------------------------------------------------------------
-- Das Etikett am Eintrag.
-- ---------------------------------------------------------------------------

ALTER TABLE `Appointment` ADD COLUMN `labelId` VARCHAR(191) NULL;
CREATE INDEX `Appointment_labelId_idx` ON `Appointment`(`labelId`);
ALTER TABLE `Appointment`
  ADD CONSTRAINT `Appointment_labelId_fkey`
  FOREIGN KEY (`labelId`) REFERENCES `CalendarLabel`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MeetingActivity` ADD COLUMN `labelId` VARCHAR(191) NULL;
CREATE INDEX `MeetingActivity_labelId_idx` ON `MeetingActivity`(`labelId`);
ALTER TABLE `MeetingActivity`
  ADD CONSTRAINT `MeetingActivity_labelId_fkey`
  FOREIGN KEY (`labelId`) REFERENCES `CalendarLabel`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CrmTask` ADD COLUMN `labelId` VARCHAR(191) NULL;
CREATE INDEX `CrmTask_labelId_idx` ON `CrmTask`(`labelId`);
ALTER TABLE `CrmTask`
  ADD CONSTRAINT `CrmTask_labelId_fkey`
  FOREIGN KEY (`labelId`) REFERENCES `CalendarLabel`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Altbestaende nachbesetzen -- genau der Stand, den der Kalender bisher
-- ABGELEITET hat, jetzt als gewaehltes Etikett festgeschrieben.
-- ---------------------------------------------------------------------------

-- Termin: abgesagt/abgeschlossen oder vorbei -> «Vergangener Termin».
UPDATE `Appointment` a
JOIN `CalendarLabel` l ON l.`tenantId` = a.`tenantId` AND l.`systemKey` = 'PAST'
SET a.`labelId` = l.`id`
WHERE a.`labelId` IS NULL
  AND (a.`status` IN ('CANCELLED', 'COMPLETED') OR a.`endTime` < NOW(3));

-- Termin: angefangen, aber noch nicht vorbei -> «Laufender Termin».
UPDATE `Appointment` a
JOIN `CalendarLabel` l ON l.`tenantId` = a.`tenantId` AND l.`systemKey` = 'ONGOING'
SET a.`labelId` = l.`id`
WHERE a.`labelId` IS NULL AND a.`startTime` <= NOW(3);

-- Termin: alles Uebrige steht noch bevor -> «Geplanter Termin».
UPDATE `Appointment` a
JOIN `CalendarLabel` l ON l.`tenantId` = a.`tenantId` AND l.`systemKey` = 'PLANNED'
SET a.`labelId` = l.`id`
WHERE a.`labelId` IS NULL;

UPDATE `MeetingActivity` m
JOIN `CalendarLabel` l ON l.`tenantId` = m.`tenantId` AND l.`systemKey` = 'MEETING'
SET m.`labelId` = l.`id`
WHERE m.`labelId` IS NULL AND m.`kind` <> 'TASK';

UPDATE `MeetingActivity` m
JOIN `CalendarLabel` l ON l.`tenantId` = m.`tenantId` AND l.`systemKey` = 'TASK'
SET m.`labelId` = l.`id`
WHERE m.`labelId` IS NULL AND m.`kind` = 'TASK';

UPDATE `CrmTask` k
JOIN `CalendarLabel` l ON l.`tenantId` = k.`tenantId` AND l.`systemKey` = 'TASK'
SET k.`labelId` = l.`id`
WHERE k.`labelId` IS NULL;
