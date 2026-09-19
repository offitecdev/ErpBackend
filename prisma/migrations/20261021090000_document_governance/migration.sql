-- BELEGVERLAUF UND EIGENE RECHTE FÜR RÜCKNAHMEN (16.09.2026, Schritt 4 / D1 + D2).
--
-- 1. `DocumentEvent` — der unlöschbare Verlauf jedes Belegs (siehe governance.prisma).
-- 2. Fünf neue Rechte: Stornieren und Zurücksetzen hingen bisher an den
--    allgemeinen Verwaltungsrechten (tenders.manage / projects.manage /
--    billing.manage). Sie stehen jetzt auf Stufe 3 der jeweiligen Seite:
--      sales.quotes   → tenders.cancel
--      sales.orders   → salesOrders.cancel, salesOrders.revert, invoices.cancel
--      projects.list  → projects.cancel
--      sales.invoices → invoices.cancel
-- 3. NIEMAND verliert heute etwas: wer die Handlung bisher ausführen durfte,
--    bekommt das neue Recht und — in der gespeicherten Stufenkarte — Stufe 3
--    auf der Seite. Die Verwaltung kann es danach Rolle für Rolle zurücknehmen.
--    Die Administratorrolle bekommt alles.
--
-- Apply with: npx prisma migrate deploy

-- ── 1. Verlauf ───────────────────────────────────────────────────────────────
CREATE TABLE `DocumentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(24) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `documentNumber` VARCHAR(191) NULL,
    `action` VARCHAR(40) NOT NULL,
    `reason` TEXT NULL,
    `override` BOOLEAN NOT NULL DEFAULT false,
    `overriddenBlockers` JSON NULL,
    `snapshot` JSON NULL,
    `projectId` VARCHAR(191) NULL,
    `tenderId` VARCHAR(191) NULL,
    `salesOrderId` VARCHAR(191) NULL,
    `actorId` VARCHAR(191) NULL,
    `actorName` VARCHAR(191) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DocumentEvent_tenantId_entityType_entityId_createdAt_idx`(`tenantId`, `entityType`, `entityId`, `createdAt`),
    INDEX `DocumentEvent_tenantId_projectId_idx`(`tenantId`, `projectId`),
    INDEX `DocumentEvent_tenantId_tenderId_idx`(`tenantId`, `tenderId`),
    INDEX `DocumentEvent_tenantId_salesOrderId_idx`(`tenantId`, `salesOrderId`),
    INDEX `DocumentEvent_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 2. Rechte ────────────────────────────────────────────────────────────────
INSERT IGNORE INTO `Permission` (`id`, `permissionName`) VALUES
    ('gov_tender_cancel', 'tenders.cancel'),
    ('gov_order_cancel', 'salesOrders.cancel'),
    ('gov_order_revert', 'salesOrders.revert'),
    ('gov_project_cancel', 'projects.cancel'),
    ('gov_invoice_cancel', 'invoices.cancel');

-- ── 3a. Rechtezeilen: wer es bisher durfte, darf es weiter ────────────────────
-- Offerte stornieren lief über tenders.manage.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT DISTINCT rp.`roleId`, np.`id`
  FROM `RolePermission` rp
  JOIN `Permission` op ON op.`id` = rp.`permissionId` AND op.`permissionName` = 'tenders.manage'
  JOIN `Permission` np ON np.`permissionName` = 'tenders.cancel';

-- Auftrag stornieren / zurücksetzen, Projekt stornieren lief über projects.manage.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT DISTINCT rp.`roleId`, np.`id`
  FROM `RolePermission` rp
  JOIN `Permission` op ON op.`id` = rp.`permissionId` AND op.`permissionName` = 'projects.manage'
  JOIN `Permission` np ON np.`permissionName` IN ('salesOrders.cancel', 'salesOrders.revert', 'projects.cancel', 'invoices.cancel');

-- Rechnung stornieren lief über billing.manage: Rollen mit Rechnungsliste auf Stufe 3 …
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, np.`id`
  FROM `Role` r
  JOIN `Permission` np ON np.`permissionName` = 'invoices.cancel'
 WHERE r.`pageLevels` IS NOT NULL
   AND JSON_VALID(r.`pageLevels`)
   AND JSON_EXTRACT(r.`pageLevels`, '$."sales.invoices"') = 3;

-- … und Altrollen ohne Stufenkarte, die billing.manage tragen.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT DISTINCT rp.`roleId`, np.`id`
  FROM `RolePermission` rp
  JOIN `Role` r ON r.`id` = rp.`roleId` AND r.`pageLevels` IS NULL
  JOIN `Permission` op ON op.`id` = rp.`permissionId` AND op.`permissionName` = 'billing.manage'
  JOIN `Permission` np ON np.`permissionName` = 'invoices.cancel';

-- Die Administratorrolle bekommt alle fünf.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, np.`id`
  FROM `Role` r
  JOIN `Permission` np ON np.`permissionName` IN ('tenders.cancel', 'salesOrders.cancel', 'salesOrders.revert', 'projects.cancel', 'invoices.cancel')
 WHERE r.`isSystemAdmin` = 1;

-- ── 3b. Stufenkarten: die Seite steht dort, wo das Recht jetzt wohnt ──────────
-- Ohne diesen Schritt nähme das nächste Speichern der Rolle die Rechte oben
-- wieder weg (die Rechte werden beim Speichern aus der Karte abgeleitet).
UPDATE `Role` r
   SET r.`pageLevels` = JSON_SET(r.`pageLevels`, '$."sales.quotes"', 3)
 WHERE r.`pageLevels` IS NOT NULL
   AND JSON_VALID(r.`pageLevels`)
   AND JSON_EXTRACT(r.`pageLevels`, '$."sales.quotes"') = 2
   AND EXISTS (
       SELECT 1 FROM `RolePermission` rp
         JOIN `Permission` p ON p.`id` = rp.`permissionId`
        WHERE rp.`roleId` = r.`id` AND p.`permissionName` = 'tenders.manage'
   );

UPDATE `Role` r
   SET r.`pageLevels` = JSON_SET(r.`pageLevels`, '$."sales.orders"', 3)
 WHERE r.`pageLevels` IS NOT NULL
   AND JSON_VALID(r.`pageLevels`)
   AND JSON_EXTRACT(r.`pageLevels`, '$."sales.orders"') = 2
   AND EXISTS (
       SELECT 1 FROM `RolePermission` rp
         JOIN `Permission` p ON p.`id` = rp.`permissionId`
        WHERE rp.`roleId` = r.`id` AND p.`permissionName` = 'projects.manage'
   );

UPDATE `Role` r
   SET r.`pageLevels` = JSON_SET(r.`pageLevels`, '$."projects.list"', 3)
 WHERE r.`pageLevels` IS NOT NULL
   AND JSON_VALID(r.`pageLevels`)
   AND JSON_EXTRACT(r.`pageLevels`, '$."projects.list"') = 2
   AND EXISTS (
       SELECT 1 FROM `RolePermission` rp
         JOIN `Permission` p ON p.`id` = rp.`permissionId`
        WHERE rp.`roleId` = r.`id` AND p.`permissionName` = 'projects.manage'
   );
