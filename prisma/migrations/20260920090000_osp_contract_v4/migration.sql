-- OSP (20.09.2026): die VIERTE Vertragsfassung von offer-integration-api.md.
--
-- Der eine Satz, aus dem alles Uebrige folgt: EINE ANFRAGE IST EIN PROJEKT.
-- Wer drueben "Get Offer" drueckt, fragt nicht eine Einheit an, sondern sein
-- ganzes Projekt, und bekommt darauf EINE Antwort. Der Stand lebt daher am
-- Projekt (§0), §1/§1a schicken EIN Objekt je Projekt mit den Datenblaettern
-- darunter (`projectDetails`), und §3/§4/§4b nehmen eine Projektnummer und
-- antworten mit EINEM Objekt statt einer Liste.
--
-- Daraus hier:
--  * `OspUnit` - die angefragten Einheiten eines Projekts. Jede bringt ihr
--    eigenes Datenblatt und ihre eigenen berechneten Zahlen mit; der Import
--    macht daraus eine Offertposition je Einheit.
--  * `OspFeedEntry` - der Aktivitaetsstrom (§1c). Das ist AUSDRUECKLICH KEINE
--    Anfrage: niemand hat um eine Offerte gebeten, es haengt kein Stand daran.
--    Eigene Tabelle, damit diese Zeilen nie in der Anfrageliste landen, aus der
--    der Verkauf arbeitet.
--  * `OspDocument.ospProjectId` / `changes` / `feedRevised*` - die Projekt-Id
--    der OSP, was die letzte Ueberarbeitung am PROJEKT bewegt hat, und der
--    Hinweis des Stroms, dass ein Datenblatt drueben neu gerendert wurde.
--
-- Am Ende werden die alten Zeilen (eine je Einheit, Referenz "4820193-57")
-- zu einer Projektzeile mit Einheiten darunter zusammengelegt.

-- ── 1) Die Anfrage kennt ihr Projekt, ihre Aenderungen und den Strom ────────
ALTER TABLE `OspDocument`
    ADD COLUMN `ospProjectId` INTEGER NULL,
    ADD COLUMN `changes` JSON NULL,
    ADD COLUMN `feedRevisedAt` DATETIME(3) NULL,
    ADD COLUMN `feedRevisedSource` VARCHAR(191) NULL;

-- ── 2) Die angefragten Einheiten ────────────────────────────────────────────
CREATE TABLE `OspUnit` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `ospDocumentId` VARCHAR(191) NOT NULL,
    `unitName` VARCHAR(191) NULL,
    `unitModel` VARCHAR(191) NULL,
    `pdfUrl` TEXT NULL,
    `datasheetFile` VARCHAR(191) NULL,
    `datasheetFetchedAt` DATETIME(3) NULL,
    `datasheetError` TEXT NULL,
    `datasheetSpecs` JSON NULL,
    `changes` JSON NULL,
    `receivedAt` DATETIME(3) NULL,
    `rawPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OspUnit_tenantId_ospDocumentId_idx`(`tenantId`, `ospDocumentId`),
    UNIQUE INDEX `OspUnit_requestId_ospDocumentId_key`(`requestId`, `ospDocumentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `OspUnit`
    ADD CONSTRAINT `OspUnit_requestId_fkey` FOREIGN KEY (`requestId`)
    REFERENCES `OspDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3) Der Aktivitaetsstrom (§1c) ───────────────────────────────────────────
CREATE TABLE `OspFeedEntry` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `ospDocumentId` VARCHAR(191) NOT NULL,
    `ospProjectId` INTEGER NULL,
    `projectNumber` VARCHAR(191) NULL,
    `projectName` VARCHAR(191) NULL,
    `projectCreatedAt` DATETIME(3) NULL,
    `requesterFirstName` VARCHAR(191) NULL,
    `requesterLastName` VARCHAR(191) NULL,
    `requesterEmail` VARCHAR(191) NULL,
    `company` VARCHAR(191) NULL,
    `unitName` VARCHAR(191) NULL,
    `unitModel` VARCHAR(191) NULL,
    `pdfUrl` TEXT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'CALCULATION',
    `filedAt` DATETIME(3) NULL,
    `coolingCapacityKw` VARCHAR(191) NULL,
    `heatingCapacityKw` VARCHAR(191) NULL,
    `eer` VARCHAR(191) NULL,
    `cop` VARCHAR(191) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `rawPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OspFeedEntry_tenantId_filedAt_idx`(`tenantId`, `filedAt`),
    INDEX `OspFeedEntry_tenantId_projectNumber_idx`(`tenantId`, `projectNumber`),
    UNIQUE INDEX `OspFeedEntry_tenantId_ospDocumentId_key`(`tenantId`, `ospDocumentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 4) Was da ist, wird umgehaengt statt weggeworfen ────────────────────────
-- Jede bisherige Zeile WAR eine Einheit: ihr Datenblatt, ihre gelesenen
-- Angaben und ihr roher Webhook-Eintrag gehoeren jetzt an eine `OspUnit`.
-- Fehlt die Dokument-Id (sehr alte Zeile), tritt die Zeilen-Id an ihre Stelle;
-- sie ist ebenso eindeutig, nur nicht die der OSP.
INSERT INTO `OspUnit` (
    `id`, `tenantId`, `requestId`, `ospDocumentId`, `unitModel`, `pdfUrl`,
    `datasheetFile`, `datasheetFetchedAt`, `datasheetError`, `datasheetSpecs`,
    `receivedAt`, `rawPayload`, `createdAt`, `updatedAt`
)
SELECT
    LEFT(REPLACE(UUID(), '-', ''), 12),
    d.`tenantId`,
    d.`id`,
    COALESCE(NULLIF(d.`documentId`, ''), d.`id`),
    d.`model`,
    d.`datasheetUrl`,
    d.`datasheetFile`,
    d.`datasheetFetchedAt`,
    d.`datasheetError`,
    d.`datasheetSpecs`,
    d.`createdAt`,
    d.`rawPayload`,
    d.`createdAt`,
    CURRENT_TIMESTAMP(3)
FROM `OspDocument` d;

-- ── 5) Mehrere Zeilen EINES Projekts werden EINE Anfrage ────────────────────
-- Die Hauptzeile ist die, an der die Arbeit haengt: zuerst die mit einer
-- Offerte, dann die im weitesten Stand, zuletzt die aelteste.
CREATE TABLE `_OspV4Primary` (
    `tenantId` VARCHAR(191) NOT NULL,
    `projectNumber` VARCHAR(191) NOT NULL,
    `primaryId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`tenantId`, `projectNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_OspV4Primary` (`tenantId`, `projectNumber`, `primaryId`)
SELECT d.`tenantId`, d.`projectNumber`, (
    SELECT p.`id` FROM `OspDocument` p
    WHERE p.`tenantId` = d.`tenantId` AND p.`projectNumber` = d.`projectNumber`
    ORDER BY (p.`tenderId` IS NOT NULL) DESC,
             FIELD(p.`status`, 'APPROVED', 'SENT', 'IN_OFFER', 'WITHDRAWN', 'LISTED'),
             p.`createdAt` ASC, p.`id` ASC
    LIMIT 1
)
FROM `OspDocument` d
GROUP BY d.`tenantId`, d.`projectNumber`;

-- Die Einheiten der Nebenzeilen gehoeren unter die Hauptzeile.
UPDATE `OspUnit` u
JOIN `OspDocument` d ON d.`id` = u.`requestId`
JOIN `_OspV4Primary` p ON p.`tenantId` = d.`tenantId` AND p.`projectNumber` = d.`projectNumber`
SET u.`requestId` = p.`primaryId`
WHERE u.`requestId` <> p.`primaryId`;

-- Nebenzeilen OHNE eigene Offerte verschwinden - ihre Einheit steht jetzt an
-- der Hauptzeile. Eine Nebenzeile MIT Offerte bleibt unangetastet: an ihr
-- haengt ein eigener Beleg, den keine Zusammenlegung wegnehmen darf.
DELETE d FROM `OspDocument` d
JOIN `_OspV4Primary` p ON p.`tenantId` = d.`tenantId` AND p.`projectNumber` = d.`projectNumber`
WHERE d.`id` <> p.`primaryId` AND d.`tenderId` IS NULL;

-- Und die Hauptzeile heisst ab jetzt nach ihrem PROJEKT (§0).
UPDATE `OspDocument` d
JOIN `_OspV4Primary` p ON p.`primaryId` = d.`id`
SET d.`reference` = d.`projectNumber`
WHERE d.`reference` <> d.`projectNumber`
  AND NOT EXISTS (
      SELECT 1 FROM (SELECT `id`, `tenantId`, `reference` FROM `OspDocument`) x
      WHERE x.`tenantId` = d.`tenantId` AND x.`reference` = d.`projectNumber` AND x.`id` <> d.`id`
  );

DROP TABLE `_OspV4Primary`;
