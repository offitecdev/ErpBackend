-- Aufgaben: mehrere Verantwortliche, Notizen mit Bildern, Freigabe-Lauf (18.08.2026).
--
-- Eine Aufgabe/Erinnerung kann an MEHRERE Personen gehen (CrmTaskAssignee);
-- die Altspalte assigneeEmployeeId bleibt als "erste Verantwortliche" gespiegelt
-- und wird hier aus dem Bestand in die neue Tabelle übertragen. Notizen samt
-- Bildern (Daten-URLs wie bei den Rapporten) hängen an der Aufgabe. Eine
-- fremd zugewiesene Aufgabe wird beim Erledigen PENDING_APPROVAL, bis die
-- zuweisende Person freigibt oder ablehnt (submittedAt / approvedAt).

ALTER TABLE `CrmTask`
    ADD COLUMN `submittedAt` DATETIME(3) NULL AFTER `createdByEmployeeId`,
    ADD COLUMN `approvedAt` DATETIME(3) NULL AFTER `submittedAt`,
    ADD COLUMN `approvedByEmployeeId` VARCHAR(191) NULL AFTER `approvedAt`;

ALTER TABLE `CrmTask`
    ADD CONSTRAINT `CrmTask_approvedByEmployeeId_fkey`
    FOREIGN KEY (`approvedByEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `CrmTaskAssignee` (
    `id` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `notifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CrmTaskAssignee_taskId_employeeId_key`(`taskId`, `employeeId`),
    INDEX `CrmTaskAssignee_employeeId_notifiedAt_idx`(`employeeId`, `notifiedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmTaskAssignee`
    ADD CONSTRAINT `CrmTaskAssignee_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `CrmTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `CrmTaskAssignee_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `CrmTaskNote` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `authorEmployeeId` VARCHAR(191) NOT NULL,
    `text` TEXT NOT NULL,
    `images` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CrmTaskNote_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmTaskNote`
    ADD CONSTRAINT `CrmTaskNote_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `CrmTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `CrmTaskNote_authorEmployeeId_fkey` FOREIGN KEY (`authorEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bestand: die bisherige einzelne Verantwortliche wird zur ersten Zeile der
-- neuen Tabelle; der Erinnerungs-Stempel wandert mit, damit nichts erneut läutet.
INSERT INTO `CrmTaskAssignee` (`id`, `taskId`, `employeeId`, `notifiedAt`, `createdAt`)
SELECT CONCAT('ta_', SUBSTRING(MD5(CONCAT(tk.id, ':', tk.assigneeEmployeeId)), 1, 16)),
       tk.id, tk.assigneeEmployeeId, tk.notifiedAt, tk.createdAt
  FROM `CrmTask` tk
 WHERE tk.assigneeEmployeeId IS NOT NULL;
