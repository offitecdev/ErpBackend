-- Konfigurierbare Erinnerungen (Benutzerwunsch 2026-08-14): je Belegart
-- beliebig viele Regeln relativ zum Bezugsdatum (Angebot: gültig bis,
-- Rechnung: fällig am). AUTO-Regeln erzeugen Erinnerungs-Einblendungen,
-- MANUAL-Regeln eine offene Aufgabe ("manuelle Nachverfolgung ab hier").
-- ReminderDispatch verhindert, dass derselbe Termin bei jedem Takt des
-- Hintergrunddienstes erneut feuert.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `ReminderRule` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'AUTO',
    `offsetDays` INT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReminderRule_tenantId_entityType_idx`(`tenantId`, `entityType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReminderDispatch` (
    `id` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `firedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReminderDispatch_ruleId_entityId_key`(`ruleId`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
