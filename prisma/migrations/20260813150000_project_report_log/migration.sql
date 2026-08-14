-- Speicherprotokoll des Montage-Rapports (Benutzerwunsch 2026-08-13): jede
-- Speicherung / Fertigstellung / Signatur schreibt eine Zeile (wer, wann, was);
-- die Projektleiter-Ansicht zeigt sie über den Protokoll-Knopf im Rapport-Editor.
-- "Der letzte Speicherstand gilt" — das Protokoll macht nachvollziehbar, wessen
-- Stand das ist.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `ProjectReportLog` (
    `id` VARCHAR(191) NOT NULL,
    `reportId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProjectReportLog_reportId_createdAt_idx`(`reportId`, `createdAt`),
    INDEX `ProjectReportLog_employeeId_idx`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProjectReportLog` ADD CONSTRAINT `ProjectReportLog_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `ProjectReport`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProjectReportLog` ADD CONSTRAINT `ProjectReportLog_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
