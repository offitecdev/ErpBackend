-- Erinnerungen neu (Benutzerwunsch 2026-08-15): statt Regel-Listen mit Art
-- und Richtung gibt es je Belegart GENAU EINE Einstellung — Vorlauf (Tage vor
-- dem Bezugsdatum, höchstens 30) und Wiederholung (alle N Tage). Der alte
-- Regelbestand ist damit gegenstandslos und wird verworfen; der Zünd-Verlauf
-- hängt jetzt am Termin (entityType, entityId, dueAt), nicht mehr an einer
-- Regel-id. Erinnerungen tragen ein Sprungziel und sprachneutrale Bausteine.
--
-- Apply with: npx prisma migrate deploy

DROP TABLE IF EXISTS `ReminderDispatch`;
DROP TABLE IF EXISTS `ReminderRule`;

CREATE TABLE `ReminderSetting` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `leadDays` INT NOT NULL,
    `intervalDays` INT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReminderSetting_tenantId_entityType_key`(`tenantId`, `entityType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReminderDispatch` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `firedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReminderDispatch_entityType_entityId_dueAt_key`(`entityType`, `entityId`, `dueAt`),
    INDEX `ReminderDispatch_tenantId_firedAt_idx`(`tenantId`, `firedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmTask`
    ADD COLUMN `linkUrl` VARCHAR(191) NULL,
    ADD COLUMN `meta` JSON NULL;
