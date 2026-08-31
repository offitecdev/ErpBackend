-- ═══ DER ÜBERNOMMENE TERMIN GEHÖRT DEM POSTFACH, NICHT DER FIRMA ═══════════
--
-- Vorgabe 31.08.2026 (Samet): «ich bekomme Termine aus einem anderen Konto,
-- obwohl ich es gewechselt habe — die gehören nicht mir; und das soll für
-- denselben Benutzer in allen Mandanten dasselbe sein.»
--
-- Befund in den Echtdaten: 56 aus Outlook übernommene Termine lagen auf
-- `main-tenant` und stammten samt und sonders vom ALTEN Postfach
-- (sahin@offitec.ch, am 28.08. abgerufen). Das neue Konto (sck@offitec.eu)
-- hatte davon genau einen. Sie überlebten den Wechsel, weil das Aufräumen nur
-- lief, wenn die Zeile AM STAMM ihre Kennung änderte — die Stammzeile wurde
-- aber neu ANGELEGT, hatte also keine vorherige Kennung, und niemand konnte
-- einem Termin ansehen, aus welchem Konto er stammte.
--
-- Drei Schritte:
--   1. Jede übernommene Zeile bekommt die Kennung des Postfachs, das sie
--      geholt hat (`externalMailbox`), und den Weg (`externalSource`).
--   2. Was nicht zum HEUTE eingerichteten Postfach gehört, fällt weg — genau
--      die Regel, die beim Postfachwechsel ohnehin gilt.
--   3. Der Rest zieht an den Stamm des Firmenbaums, dorthin, wo auch das
--      Postfach und die Nachrichten liegen. Damit sieht derselbe Benutzer in
--      jeder Firma denselben Kalenderbestand.

ALTER TABLE `MeetingActivity`
  ADD COLUMN `externalMailbox` VARCHAR(255) NULL,
  ADD COLUMN `externalSource`  VARCHAR(16)  NULL;

CREATE INDEX `MeetingActivity_externalMailbox_startTime_idx`
  ON `MeetingActivity`(`externalMailbox`, `startTime`);

ALTER TABLE `MailSetting`
  ADD COLUMN `caldavEnabled`     BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN `caldavUrl`         VARCHAR(512) NULL,
  ADD COLUMN `caldavUser`        VARCHAR(255) NULL,
  ADD COLUMN `caldavPassword`    TEXT         NULL,
  ADD COLUMN `caldavCalendars`   JSON         NULL,
  ADD COLUMN `caldavLastSyncAt`  DATETIME(3)  NULL,
  ADD COLUMN `caldavLastError`   TEXT         NULL,
  ADD COLUMN `caldavLastSummary` VARCHAR(255) NULL;

-- 1. Kennung nachtragen. Sie wird genau so gebildet wie im Code
--    (`mailboxIdentity`): kleingeschrieben, Server + "|" + Postfachadresse,
--    und die Adresse ist der IMAP-Benutzer, sonst der SMTP-Benutzer, sonst die
--    Absenderadresse. Gesucht wird zuerst die Einstellung DER FIRMA, in der der
--    Termin liegt (dort wurde er abgerufen), sonst die des Stamms.
UPDATE `MeetingActivity` m
  JOIN `Tenant` t          ON t.id = m.tenantId
  LEFT JOIN `MailSetting` own  ON own.tenantId  = m.tenantId
  LEFT JOIN `MailSetting` root ON root.tenantId = COALESCE(t.parentTenantId, m.tenantId)
SET m.externalSource  = 'MAIL',
    m.externalMailbox = LOWER(CONCAT(
      COALESCE(TRIM(COALESCE(own.imapHost, root.imapHost)), ''), '|',
      COALESCE(
        NULLIF(TRIM(COALESCE(own.imapUser,  root.imapUser)),  ''),
        NULLIF(TRIM(COALESCE(own.smtpUser,  root.smtpUser)),  ''),
        NULLIF(TRIM(COALESCE(own.fromEmail, root.fromEmail)), ''),
        '')))
WHERE m.externalOrigin IS NOT NULL;

-- Ohne auffindbares Postfach bleibt die Kennung leer statt "|" — eine solche
-- Zeile gehört niemandem und wird im nächsten Schritt entfernt.
UPDATE `MeetingActivity` SET `externalMailbox` = NULL
WHERE `externalOrigin` IS NOT NULL AND `externalMailbox` = '|';

-- 2. Fremdes Konto raus. Massstab ist die Einrichtung AM STAMM des Baums —
--    das ist das eine Postfach dieses Hauses.
DELETE m FROM `MeetingActivity` m
  JOIN `Tenant` t ON t.id = m.tenantId
  LEFT JOIN `MailSetting` root ON root.tenantId = COALESCE(t.parentTenantId, m.tenantId)
WHERE m.externalOrigin IS NOT NULL
  AND (m.externalMailbox IS NULL
       OR m.externalMailbox <> LOWER(CONCAT(
            COALESCE(TRIM(root.imapHost), ''), '|',
            COALESCE(
              NULLIF(TRIM(root.imapUser),  ''),
              NULLIF(TRIM(root.smtpUser),  ''),
              NULLIF(TRIM(root.fromEmail), ''),
              ''))));

-- 3. An den Stamm ziehen. Zuerst die Zusammenstösse wegräumen: liegt derselbe
--    Termin (gleiche UID) schon am Stamm, gewinnt die Zeile am Stamm — der
--    eindeutige Schlüssel (tenantId, icalUid) liesse die zweite ohnehin nicht zu.
DELETE child FROM `MeetingActivity` child
  JOIN `Tenant` t ON t.id = child.tenantId
  JOIN `MeetingActivity` parent
    ON parent.tenantId = t.parentTenantId AND parent.icalUid = child.icalUid
WHERE child.externalOrigin IS NOT NULL AND t.parentTenantId IS NOT NULL;

UPDATE `MeetingActivity` m
  JOIN `Tenant` t ON t.id = m.tenantId
SET m.tenantId = t.parentTenantId
WHERE m.externalOrigin IS NOT NULL AND t.parentTenantId IS NOT NULL;

-- Der Baum ist heute zwei Ebenen tief; damit eine tiefere Verschachtelung
-- nicht auf halber Strecke stehen bleibt, laufen Zusammenstoss-Prüfung und
-- Verschiebung noch zweimal. Zeilen, die schon am Stamm liegen, haben kein
-- `parentTenantId` mehr und werden von beiden Läufen nicht angefasst.
DELETE child FROM `MeetingActivity` child
  JOIN `Tenant` t ON t.id = child.tenantId
  JOIN `MeetingActivity` parent
    ON parent.tenantId = t.parentTenantId AND parent.icalUid = child.icalUid
WHERE child.externalOrigin IS NOT NULL AND t.parentTenantId IS NOT NULL;

UPDATE `MeetingActivity` m
  JOIN `Tenant` t ON t.id = m.tenantId
SET m.tenantId = t.parentTenantId
WHERE m.externalOrigin IS NOT NULL AND t.parentTenantId IS NOT NULL;

DELETE child FROM `MeetingActivity` child
  JOIN `Tenant` t ON t.id = child.tenantId
  JOIN `MeetingActivity` parent
    ON parent.tenantId = t.parentTenantId AND parent.icalUid = child.icalUid
WHERE child.externalOrigin IS NOT NULL AND t.parentTenantId IS NOT NULL;

UPDATE `MeetingActivity` m
  JOIN `Tenant` t ON t.id = m.tenantId
SET m.tenantId = t.parentTenantId
WHERE m.externalOrigin IS NOT NULL AND t.parentTenantId IS NOT NULL;
