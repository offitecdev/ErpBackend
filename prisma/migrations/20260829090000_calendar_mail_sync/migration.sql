-- KALENDER AUS DER MAIL: EIN EINTRAG, AUTOMATISCH NACHGEFÜHRT (21.08.2026).
--
-- Vorgabe: Termine, die über die Mail in den Kalender gekommen sind, sollen
-- sich von selbst aktualisieren, wenn eine neue Fassung der Einladung eintrifft
-- — und NUR die. Was im System angelegt wurde, bleibt unangetastet. Und was wir
-- selbst angelegt UND per Mail verschickt haben, darf nicht als zweiter Eintrag
-- zurückkommen.
--
-- Dafür wird das Paar (tenantId, icalUid) EINDEUTIG: es ist der Schlüssel, an
-- dem eine hereinkommende Einladung ihren Termin wiedererkennt. Solange es nur
-- ein Index war, konnten zwei gleichzeitige Abrufe denselben Termin doppelt
-- anlegen. Vorhandene Doppel werden vorher aufgelöst.
--
-- `meetingUrl` hält den Beitrittslink einer Online-Besprechung (Teams, Zoom,
-- Meet), damit der Termin im Kalender direkt anklickbar ist.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `MeetingActivity`
    ADD COLUMN `meetingUrl` VARCHAR(512) NULL;

-- 1. Doppel aus der Mail: der ÄLTESTE Eintrag je UID bleibt, die späteren
--    Kopien gehen. Teilnehmerzeilen hängen mit ON DELETE CASCADE daran;
--    importierte Termine führen ohnehin keine.
DELETE m FROM `MeetingActivity` m
    JOIN `MeetingActivity` k
      ON k.`tenantId` = m.`tenantId`
     AND k.`icalUid` = m.`icalUid`
     AND (k.`createdAt` < m.`createdAt` OR (k.`createdAt` = m.`createdAt` AND k.`id` < m.`id`))
   WHERE m.`icalUid` IS NOT NULL
     AND m.`externalOrigin` IS NOT NULL;

-- 2. Sollte danach noch ein Doppel übrig sein, steckt ein SELBST angelegter
--    Termin darin. Der wird nicht gelöscht — ihm wird die UID genommen. Folge:
--    eine spätere Einladung aus ihm heraus bekommt eine neue UID und damit beim
--    Empfänger einen neuen Kalendereintrag. Das ist der harmlosere Preis.
UPDATE `MeetingActivity`
   SET `icalUid` = NULL
 WHERE `id` IN (
    SELECT `id` FROM (
        SELECT m.`id` AS `id`
          FROM `MeetingActivity` m
          JOIN `MeetingActivity` k
            ON k.`tenantId` = m.`tenantId`
           AND k.`icalUid` = m.`icalUid`
           AND (k.`createdAt` < m.`createdAt` OR (k.`createdAt` = m.`createdAt` AND k.`id` < m.`id`))
         WHERE m.`icalUid` IS NOT NULL
    ) AS `duplicates`
 );

-- 3. Index → eindeutiger Schlüssel. NULL bleibt in MySQL beliebig oft erlaubt,
--    Termine ohne verschickte Einladung stören also nicht.
DROP INDEX `MeetingActivity_tenantId_icalUid_idx` ON `MeetingActivity`;
CREATE UNIQUE INDEX `MeetingActivity_tenantId_icalUid_key` ON `MeetingActivity`(`tenantId`, `icalUid`);

-- 4. Die Gegenprobe beim Import ("gehört diese UID zu einem eigenen
--    Projekttermin?") läuft sonst als Tabellenscan über alle Termine.
CREATE INDEX `Appointment_tenantId_icalUid_idx` ON `Appointment`(`tenantId`, `icalUid`);
