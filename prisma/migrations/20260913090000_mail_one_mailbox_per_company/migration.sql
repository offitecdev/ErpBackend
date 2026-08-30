-- EIN POSTFACH JE FIRMA (13.09.2026, Vorgabe Samet: «alle Mails an den
-- Hauptmandanten hängen; in Untermandanten darf es für persönliche Post keine
-- Trennung geben»).
--
-- AUSGANGSLAGE: Postfach-Zugangsdaten wurden je Mandant geführt. Standen in
-- zwei Mandanten desselben Firmenbaums dieselben IMAP-Daten, holten ZWEI
-- Abrufe DASSELBE Postfach und legten jede Nachricht zweimal ab — und wer den
-- Mandanten wechselte, sah eine zweite, halb gefüllte Kopie seines Postfachs.
-- Erschwerend: der einzige Doppel-Schutz war `[accountId, providerMessageId]`,
-- und `accountId` ist beim Firmenpostfach immer NULL — in MySQL sperrt ein
-- UNIQUE-Index mit NULL-Spalte gar nichts. `skipDuplicates` lief also ins
-- Leere, und schon zwei gleichzeitige Durchgänge DESSELBEN Mandanten legten
-- dieselbe Nachricht mehrfach an.
--
-- DIESE MIGRATION:
--   1. hängt Kategorien und Nachrichten an den KOPF des Firmenbaums,
--   2. legt doppelte Kategorien zusammen (die Nachrichten behalten ihre
--      Zuordnung, sie zeigen danach auf die verbliebene Kategorie),
--   3. entfernt doppelte Nachrichten — behalten wird die Zeile mit den
--      meisten Verknüpfungen (Kategorie, Aktivität, Beleg, Kunde, Person),
--      bei Gleichstand die älteste,
--   4. setzt den Lesestand zurück, damit der zusammengeführte Abruf das
--      Fenster einmal lückenlos neu liest (Doppelte kommen dank 5. nicht mehr
--      vor),
--   5. macht die Eindeutigkeit zu einer Sache der DATENBANK, nicht des Codes.

-- ── 1. Kategorien an den Kopf des Firmenbaums ────────────────────────────────
-- Vier Ebenen reichen weit über jede reale Firmenstruktur hinaus; COALESCE
-- greift den obersten gefundenen Vorfahren.
UPDATE `MailCategory` c
    JOIN `Tenant` t1 ON t1.id = c.tenantId
    LEFT JOIN `Tenant` t2 ON t2.id = t1.parentTenantId
    LEFT JOIN `Tenant` t3 ON t3.id = t2.parentTenantId
    LEFT JOIN `Tenant` t4 ON t4.id = t3.parentTenantId
   SET c.tenantId = COALESCE(t4.id, t3.id, t2.id, t1.id);

-- ── 2. Doppelte Kategorien zusammenlegen ─────────────────────────────────────
-- «Anfragen» (kind REQUESTS, entityId NULL) gab es je Mandant einmal — nach
-- dem Umhängen liegen mehrere im selben Baum. NULL vergleicht sich in MySQL
-- nie mit NULL, darum COALESCE über entityId.
CREATE TABLE `_MailCatMerge` (
    `dupId`  VARCHAR(191) NOT NULL,
    `keepId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`dupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_MailCatMerge` (`dupId`, `keepId`)
SELECT c.id, k.keepId
  FROM `MailCategory` c
  JOIN (
        SELECT tenantId, kind, COALESCE(entityId, '') AS ent, MIN(id) AS keepId
          FROM `MailCategory`
         GROUP BY tenantId, kind, COALESCE(entityId, '')
       ) k
    ON k.tenantId = c.tenantId AND k.kind = c.kind AND k.ent = COALESCE(c.entityId, '')
 WHERE c.id <> k.keepId;

UPDATE `MailMessage` m JOIN `_MailCatMerge` d ON d.dupId = m.categoryId
   SET m.categoryId = d.keepId;

DELETE c FROM `MailCategory` c JOIN `_MailCatMerge` d ON d.dupId = c.id;

DROP TABLE `_MailCatMerge`;

-- ── 3. Nachrichten an den Kopf des Firmenbaums ───────────────────────────────
UPDATE `MailMessage` m
    JOIN `Tenant` t1 ON t1.id = m.tenantId
    LEFT JOIN `Tenant` t2 ON t2.id = t1.parentTenantId
    LEFT JOIN `Tenant` t3 ON t3.id = t2.parentTenantId
    LEFT JOIN `Tenant` t4 ON t4.id = t3.parentTenantId
   SET m.tenantId = COALESCE(t4.id, t3.id, t2.id, t1.id);

-- ── 4. Doppelte Nachrichten entfernen ────────────────────────────────────────
CREATE TABLE `_MailDupe` (
    `dupId`  VARCHAR(191) NOT NULL,
    `keepId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`dupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4a. DIESELBE SERVER-NACHRICHT (Ordner:UIDVALIDITY:UID).
INSERT INTO `_MailDupe` (`dupId`, `keepId`)
SELECT r.id, r.keepId FROM (
    SELECT id,
           FIRST_VALUE(id) OVER w AS keepId,
           ROW_NUMBER()    OVER w AS rn
      FROM `MailMessage`
     WHERE providerMessageId IS NOT NULL
    WINDOW w AS (
        PARTITION BY tenantId, providerMessageId
        ORDER BY (categoryId IS NULL), (activityId IS NULL), (entityId IS NULL),
                 (customerId IS NULL), (employeeId IS NULL), (deletedAt IS NOT NULL),
                 createdAt, id
    )
) r WHERE r.rn > 1;

-- Aus einer Nachricht kann eine ANFRAGE entstanden sein: sie zeigt auf die
-- verbleibende Zeile, sofern dort nicht schon eine Anfrage hängt (der
-- Schlüssel (tenantId, mailMessageId) lässt nur eine zu).
UPDATE `Enquiry` e JOIN `_MailDupe` d ON d.dupId = e.mailMessageId
   SET e.mailMessageId = d.keepId
 WHERE NOT EXISTS (
    SELECT 1 FROM (SELECT tenantId, mailMessageId FROM `Enquiry`) x
     WHERE x.tenantId = e.tenantId AND x.mailMessageId = d.keepId
 );

DELETE m FROM `MailMessage` m JOIN `_MailDupe` d ON d.dupId = m.id;

-- 4b. DIESELBE NACHRICHT ÜBER ZWEI WEGE: die ERP-Sendung und ihre Kopie, die
--     der Abruf später im Ordner "Gesendet" wiederfand. Zweiter Durchgang,
--     denn die in 4a behaltenen Zeilen sind erst jetzt bekannt.
DELETE FROM `_MailDupe`;

INSERT INTO `_MailDupe` (`dupId`, `keepId`)
SELECT r.id, r.keepId FROM (
    SELECT id,
           FIRST_VALUE(id) OVER w AS keepId,
           ROW_NUMBER()    OVER w AS rn
      FROM `MailMessage`
     WHERE internetMessageId IS NOT NULL
    WINDOW w AS (
        PARTITION BY tenantId, internetMessageId, direction
        ORDER BY (categoryId IS NULL), (activityId IS NULL), (entityId IS NULL),
                 (customerId IS NULL), (employeeId IS NULL), (deletedAt IS NOT NULL),
                 createdAt, id
    )
) r WHERE r.rn > 1;

UPDATE `Enquiry` e JOIN `_MailDupe` d ON d.dupId = e.mailMessageId
   SET e.mailMessageId = d.keepId
 WHERE NOT EXISTS (
    SELECT 1 FROM (SELECT tenantId, mailMessageId FROM `Enquiry`) x
     WHERE x.tenantId = e.tenantId AND x.mailMessageId = d.keepId
 );

DELETE m FROM `MailMessage` m JOIN `_MailDupe` d ON d.dupId = m.id;

DROP TABLE `_MailDupe`;

-- ── 5. Eindeutigkeit in der Datenbank verankern ──────────────────────────────
-- Der bisherige einfache Index auf (tenantId, internetMessageId) geht im neuen
-- eindeutigen Index auf — zwei Indizes über derselben Spaltenfolge kosten nur
-- Schreibzeit.
DROP INDEX `MailMessage_tenantId_internetMessageId_idx` ON `MailMessage`;

CREATE UNIQUE INDEX `MailMessage_tenantId_providerMessageId_key`
    ON `MailMessage`(`tenantId`, `providerMessageId`);
CREATE UNIQUE INDEX `MailMessage_tenantId_internetMessageId_direction_key`
    ON `MailMessage`(`tenantId`, `internetMessageId`, `direction`);

-- ── 6. Der Lesestand bleibt, wie er ist ──────────────────────────────────────
-- Bewusst KEIN Zurücksetzen: jede Nachricht unterhalb des höchsten Lesestands
-- im Baum wurde von IRGENDEINEM der zusammengelegten Mandanten schon geholt,
-- und dessen Zeilen liegen jetzt am Kopf. Steht der Kopf weiter zurück als ein
-- ehemaliger Untermandant, liest er das Stück noch einmal — die Message-ID und
-- die Schlüssel aus 5. sorgen dafür, dass dabei nichts doppelt entsteht. Ein
-- Zurücksetzen hiesse dagegen, zwei Monate ohne Not neu einzulesen.
