-- Personalmodul Neubau (16.08.2026).
-- Die Alt-Tabellen (AttendanceLog, LeaveRequest, LeaveType) bleiben absichtlich
-- stehen: ihr Code ist entfernt, ihre Daten sollen nicht verloren gehen.

-- ── Employee: Personalnummer, QR-Schlüssel, Personalrolle, Arbeitsort ────────
ALTER TABLE `Employee`
    ADD COLUMN `staffNumber` INT NULL,
    ADD COLUMN `qrToken` VARCHAR(64) NULL,
    ADD COLUMN `staffRole` VARCHAR(16) NOT NULL DEFAULT 'STAFF',
    ADD COLUMN `workLocation` VARCHAR(16) NOT NULL DEFAULT 'OFFICE';

CREATE UNIQUE INDEX `Employee_qrToken_key` ON `Employee`(`qrToken`);

-- ── Schichtplan: genau ein Plan je Mandant ───────────────────────────────────
CREATE TABLE `StaffShiftPlan` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `workdaysJson` JSON NOT NULL,
    `startTime` VARCHAR(5) NOT NULL,
    `endTime` VARCHAR(5) NOT NULL,
    `breakMinutes` INTEGER NOT NULL DEFAULT 60,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StaffShiftPlan_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Arbeitsfenster: eine Zeile = eine tatsächlich geleistete Spanne ──────────
CREATE TABLE `StaffTimeEntry` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `workDate` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `durationSeconds` INTEGER NULL,
    `source` VARCHAR(16) NOT NULL DEFAULT 'QR',
    `note` TEXT NULL,
    `editedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StaffTimeEntry_tenantId_workDate_idx`(`tenantId`, `workDate`),
    INDEX `StaffTimeEntry_employeeId_workDate_idx`(`employeeId`, `workDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Urlaubs- und Homeoffice-Anträge ──────────────────────────────────────────
CREATE TABLE `StaffLeaveRequest` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'LEAVE',
    `leaveType` VARCHAR(24) NOT NULL,
    `startDate` DATETIME(3) NOT NULL,
    `endDate` DATETIME(3) NOT NULL,
    `totalDays` INTEGER NOT NULL,
    `note` TEXT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'PENDING_MANAGER',
    `approverId` VARCHAR(191) NOT NULL,
    `managerDecisionAt` DATETIME(3) NULL,
    `managerNote` TEXT NULL,
    `accountantId` VARCHAR(191) NULL,
    `accountingDecisionAt` DATETIME(3) NULL,
    `accountingNote` TEXT NULL,
    `rejectedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StaffLeaveRequest_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `StaffLeaveRequest_employeeId_startDate_idx`(`employeeId`, `startDate`),
    INDEX `StaffLeaveRequest_approverId_status_idx`(`approverId`, `status`),
    INDEX `StaffLeaveRequest_accountantId_fkey`(`accountantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StaffTimeEntry`
    ADD CONSTRAINT `StaffTimeEntry_employeeId_fkey`
    FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `StaffLeaveRequest`
    ADD CONSTRAINT `StaffLeaveRequest_employeeId_fkey`
    FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `StaffLeaveRequest`
    ADD CONSTRAINT `StaffLeaveRequest_approverId_fkey`
    FOREIGN KEY (`approverId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `StaffLeaveRequest`
    ADD CONSTRAINT `StaffLeaveRequest_accountantId_fkey`
    FOREIGN KEY (`accountantId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
