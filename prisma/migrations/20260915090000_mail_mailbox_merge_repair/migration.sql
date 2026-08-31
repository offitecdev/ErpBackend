-- EIN POSTFACH JE FIRMA — NACHTRAG (15.09.2026)
--
-- Die Migration `20260913090000_mail_one_mailbox_per_company` hat die Bestände
-- am 30.08. zusammengelegt, aber der CODE zog nicht mit: Abruf, Postfachseite
-- und Versand lasen weiter `req.user.tenantId` statt des Stamms. Also lief
-- alles sofort wieder auseinander — innerhalb eines Tages standen 87 frische
-- Nachrichten im Untermandanten, während der Stamm 4400 führte. Wer in der
-- Untergesellschaft arbeitete, sah 45 Mails statt zweier Monate Post.
--
-- Diese Migration räumt den Rückfall auf; die Auflösung `getMailTenantId`
-- (serviceTenantScope.ts) verhindert ab sofort, dass er sich wiederholt.
--
-- Sie ist WIEDERHOLBAR: liegt schon alles am Stamm, ändert sie nichts. Anders
-- als am 13.09. bestehen die eindeutigen Schlüssel bereits — Doppelte müssen
-- darum VOR dem Umhängen verschwinden, sonst bricht das UPDATE am Schlüssel.

-- ── 1. KATEGORIEN ────────────────────────────────────────────────────────────
-- Erst zusammenlegen, dann umhängen: `[tenantId, kind, entityId]` ist
-- eindeutig, und zwei Firmen desselben Baums haben ihre Leiste je einmal.
CREATE TABLE `_MailCatRoot` (
    `id`           VARCHAR(191) NOT NULL,
    `rootTenantId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`id`),
    KEY `_MailCatRoot_root` (`rootTenantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Vier Ebenen reichen weit über jede reale Firmenstruktur hinaus; COALESCE
-- greift den obersten gefundenen Vorfahren.
INSERT INTO `_MailCatRoot` (`id`, `rootTenantId`)
SELECT c.id, COALESCE(t4.id, t3.id, t2.id, t1.id)
  FROM `MailCategory` c
  JOIN `Tenant` t1 ON t1.id = c.tenantId
  LEFT JOIN `Tenant` t2 ON t2.id = t1.parentTenantId
  LEFT JOIN `Tenant` t3 ON t3.id = t2.parentTenantId
  LEFT JOIN `Tenant` t4 ON t4.id = t3.parentTenantId;

CREATE TABLE `_MailCatMerge2` (
    `dupId`  VARCHAR(191) NOT NULL,
    `keepId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`dupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- NULL vergleicht sich in MySQL nie mit NULL — «Anfragen» (entityId NULL) fände
-- sich sonst nicht selbst, darum COALESCE.
INSERT INTO `_MailCatMerge2` (`dupId`, `keepId`)
SELECT c.id, k.keepId
  FROM `MailCategory` c
  JOIN `_MailCatRoot` cr ON cr.id = c.id
  JOIN (
        SELECT cr2.rootTenantId AS root, c2.kind AS kind,
               COALESCE(c2.entityId, '') AS ent, MIN(c2.id) AS keepId
          FROM `MailCategory` c2
          JOIN `_MailCatRoot` cr2 ON cr2.id = c2.id
         GROUP BY cr2.rootTenantId, c2.kind, COALESCE(c2.entityId, '')
       ) k
    ON k.root = cr.rootTenantId AND k.kind = c.kind AND k.ent = COALESCE(c.entityId, '')
 WHERE c.id <> k.keepId;

UPDATE `MailMessage` m JOIN `_MailCatMerge2` d ON d.dupId = m.categoryId
   SET m.categoryId = d.keepId;

DELETE c FROM `MailCategory` c JOIN `_MailCatMerge2` d ON d.dupId = c.id;

UPDATE `MailCategory` c JOIN `_MailCatRoot` cr ON cr.id = c.id
   SET c.tenantId = cr.rootTenantId
 WHERE c.tenantId <> cr.rootTenantId;

DROP TABLE `_MailCatMerge2`;
DROP TABLE `_MailCatRoot`;

-- ── 2. NACHRICHTEN ───────────────────────────────────────────────────────────
CREATE TABLE `_MailRoot` (
    `id`           VARCHAR(191) NOT NULL,
    `rootTenantId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`id`),
    KEY `_MailRoot_root` (`rootTenantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_MailRoot` (`id`, `rootTenantId`)
SELECT m.id, COALESCE(t4.id, t3.id, t2.id, t1.id)
  FROM `MailMessage` m
  JOIN `Tenant` t1 ON t1.id = m.tenantId
  LEFT JOIN `Tenant` t2 ON t2.id = t1.parentTenantId
  LEFT JOIN `Tenant` t3 ON t3.id = t2.parentTenantId
  LEFT JOIN `Tenant` t4 ON t4.id = t3.parentTenantId;

CREATE TABLE `_MailDupe2` (
    `dupId`  VARCHAR(191) NOT NULL,
    `keepId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`dupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2a. DIESELBE SERVER-NACHRICHT (Ordner:UIDVALIDITY:UID), im ganzen Baum.
--     Behalten wird die Zeile mit den meisten Verknüpfungen, bei Gleichstand
--     die ältere — dieselbe Rangfolge wie am 13.09.2026.
INSERT INTO `_MailDupe2` (`dupId`, `keepId`)
SELECT r.id, r.keepId FROM (
    SELECT m.id AS id,
           FIRST_VALUE(m.id) OVER w AS keepId,
           ROW_NUMBER()      OVER w AS rn
      FROM `MailMessage` m
      JOIN `_MailRoot` mr ON mr.id = m.id
     WHERE m.providerMessageId IS NOT NULL
    WINDOW w AS (
        PARTITION BY mr.rootTenantId, m.providerMessageId
        ORDER BY (m.categoryId IS NULL), (m.activityId IS NULL), (m.entityId IS NULL),
                 (m.customerId IS NULL), (m.employeeId IS NULL), (m.deletedAt IS NOT NULL),
                 m.createdAt, m.id
    )
) r WHERE r.rn > 1;

-- Aus einer Nachricht kann eine ANFRAGE entstanden sein: sie zeigt auf die
-- verbleibende Zeile, sofern dort nicht schon eine Anfrage hängt.
UPDATE `Enquiry` e JOIN `_MailDupe2` d ON d.dupId = e.mailMessageId
   SET e.mailMessageId = d.keepId
 WHERE NOT EXISTS (
    SELECT 1 FROM (SELECT tenantId, mailMessageId FROM `Enquiry`) x
     WHERE x.tenantId = e.tenantId AND x.mailMessageId = d.keepId
 );

DELETE m FROM `MailMessage` m JOIN `_MailDupe2` d ON d.dupId = m.id;

-- 2b. DIESELBE NACHRICHT ÜBER ZWEI WEGE: die ERP-Sendung und ihre Kopie aus
--     dem Ordner "Gesendet". Zweiter Durchgang, denn welche Zeilen 2a stehen
--     gelassen hat, ist erst jetzt bekannt.
DELETE FROM `_MailDupe2`;

INSERT INTO `_MailDupe2` (`dupId`, `keepId`)
SELECT r.id, r.keepId FROM (
    SELECT m.id AS id,
           FIRST_VALUE(m.id) OVER w AS keepId,
           ROW_NUMBER()      OVER w AS rn
      FROM `MailMessage` m
      JOIN `_MailRoot` mr ON mr.id = m.id
     WHERE m.internetMessageId IS NOT NULL
    WINDOW w AS (
        PARTITION BY mr.rootTenantId, m.internetMessageId, m.direction
        ORDER BY (m.categoryId IS NULL), (m.activityId IS NULL), (m.entityId IS NULL),
                 (m.customerId IS NULL), (m.employeeId IS NULL), (m.deletedAt IS NOT NULL),
                 m.createdAt, m.id
    )
) r WHERE r.rn > 1;

UPDATE `Enquiry` e JOIN `_MailDupe2` d ON d.dupId = e.mailMessageId
   SET e.mailMessageId = d.keepId
 WHERE NOT EXISTS (
    SELECT 1 FROM (SELECT tenantId, mailMessageId FROM `Enquiry`) x
     WHERE x.tenantId = e.tenantId AND x.mailMessageId = d.keepId
 );

DELETE m FROM `MailMessage` m JOIN `_MailDupe2` d ON d.dupId = m.id;

DROP TABLE `_MailDupe2`;

-- 2c. Was übrig ist, hängt an den Stamm.
UPDATE `MailMessage` m JOIN `_MailRoot` mr ON mr.id = m.id
   SET m.tenantId = mr.rootTenantId
 WHERE m.tenantId <> mr.rootTenantId;

DROP TABLE `_MailRoot`;

-- ── 3. EINSTELLUNGEN: NUR NOCH EIN ABRUF JE BAUM ─────────────────────────────
-- Der Abruf legt Mandanten desselben Baums seit heute zusammen (runPass), aber
-- ein eingeschalteter Schalter in einer Untergesellschaft ist eine Falle für
-- den nächsten Leser — und die Oberfläche schreibt ihre Einstellungen ohnehin
-- nur noch an den Stamm. Also hier ausschalten.
--
-- Die Zeile selbst BLEIBT: sie hält die Zugangsdaten, die jemand dort einmal
-- eingetragen hat. Und die LESESTÄNDE werden bewusst nicht angefasst — jede
-- Nachricht unterhalb eines Lesestands im Baum ist schon geholt worden und
-- liegt nach Schritt 2 am Stamm. Wo der Stamm zurückliegt, liest er das Stück
-- noch einmal; die eindeutigen Schlüssel lassen dabei kein Doppel entstehen.
UPDATE `MailSetting` s
    JOIN `Tenant` t1 ON t1.id = s.tenantId
    LEFT JOIN `Tenant` t2 ON t2.id = t1.parentTenantId
    LEFT JOIN `Tenant` t3 ON t3.id = t2.parentTenantId
    LEFT JOIN `Tenant` t4 ON t4.id = t3.parentTenantId
   SET s.imapCaptureEnabled = 0
 WHERE s.tenantId <> COALESCE(t4.id, t3.id, t2.id, t1.id);
