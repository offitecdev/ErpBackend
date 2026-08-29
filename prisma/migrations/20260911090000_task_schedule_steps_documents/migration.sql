-- AUFGABEN: ANFANG/ENDE, ANLEITUNG UND ANHÄNGE (11.09.2026, Vorgabe Samet)
--
--   1. CrmTask.startAt / allDay — eine Aufgabe hat jetzt einen ANFANG und ein
--      ENDE und darf sich über mehrere Tage ziehen. `dueDate` BLEIBT das Ende:
--      jede bestehende Zeile, der Verfalldienst und das Erinnerungsläuten
--      rechnen damit. Alte Zeilen bekommen `startAt = dueDate` (eintägig).
--   2. CrmTask.tenderId — die freiwillige Verknüpfung mit einer Offerte.
--   3. CrmTaskStep — die Schritt-für-Schritt-Anleitung (freiwillig).
--   4. CrmTaskDocument — Bilder UND PDF an der Aufgabe; die Bytes liegen auf
--      der Platte, die Zeile hält nur den Verweis.

ALTER TABLE `CrmTask`
    ADD COLUMN `startAt` DATETIME(3) NULL,
    ADD COLUMN `allDay` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `tenderId` VARCHAR(191) NULL;

-- Bestehende Aufgaben sind eintägig: der Anfang ist ihr Termin.
UPDATE `CrmTask` SET `startAt` = `dueDate` WHERE `dueDate` IS NOT NULL;

CREATE INDEX `CrmTask_tenderId_idx` ON `CrmTask`(`tenderId`);
CREATE INDEX `CrmTask_tenantId_startAt_idx` ON `CrmTask`(`tenantId`, `startAt`);

ALTER TABLE `CrmTask`
    ADD CONSTRAINT `CrmTask_tenderId_fkey`
    FOREIGN KEY (`tenderId`) REFERENCES `Tender`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `CrmTaskStep` (
    `id` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `text` VARCHAR(500) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CrmTaskStep_taskId_position_idx`(`taskId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmTaskStep`
    ADD CONSTRAINT `CrmTaskStep_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `CrmTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `CrmTaskDocument` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `contentType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `fileRef` VARCHAR(512) NOT NULL,
    `uploadedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CrmTaskDocument_taskId_createdAt_idx`(`taskId`, `createdAt`),
    INDEX `CrmTaskDocument_tenantId_idx`(`tenantId`),
    INDEX `CrmTaskDocument_uploadedById_idx`(`uploadedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmTaskDocument`
    ADD CONSTRAINT `CrmTaskDocument_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `CrmTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrmTaskDocument`
    ADD CONSTRAINT `CrmTaskDocument_uploadedById_fkey`
    FOREIGN KEY (`uploadedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
