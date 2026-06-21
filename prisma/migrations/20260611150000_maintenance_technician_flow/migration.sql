-- Maintenance contracts: code, archival state, technician flow, appointment approval, expenses, notifications.

ALTER TABLE `MaintenanceContract`
  ADD COLUMN IF NOT EXISTS `contractCode` VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS `deletedAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `overtimeHourlyRate` DOUBLE NOT NULL DEFAULT 0;

UPDATE `MaintenanceContract` mc
JOIN (
  SELECT
    `id`,
    ROW_NUMBER() OVER (PARTITION BY `tenantId` ORDER BY `createdAt`, `id`) AS seq
  FROM `MaintenanceContract`
) numbered ON numbered.`id` = mc.`id`
SET mc.`contractCode` = COALESCE(NULLIF(mc.`contractCode`, ''), CONCAT('M-', LPAD(numbered.seq, 3, '0'), '-01'));

ALTER TABLE `MaintenanceContract`
  MODIFY COLUMN `contractCode` VARCHAR(32) NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `MaintenanceContract_tenantId_contractCode_key`
  ON `MaintenanceContract` (`tenantId`, `contractCode`);

ALTER TABLE `MaintenanceTask`
  ADD COLUMN IF NOT EXISTS `scheduledStartTime` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `scheduledEndTime` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `bookingToken` VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS `reminderSentAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `managerApprovedAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `managerApprovedById` VARCHAR(191) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `MaintenanceTask_bookingToken_key`
  ON `MaintenanceTask` (`bookingToken`);
CREATE INDEX IF NOT EXISTS `MaintenanceTask_scheduledStartTime_scheduledEndTime_idx`
  ON `MaintenanceTask` (`scheduledStartTime`, `scheduledEndTime`);

CREATE TABLE IF NOT EXISTS `MaintenanceTaskAssignment` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `technicianId` VARCHAR(191) NOT NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdById` VARCHAR(191) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `MaintenanceTaskAssignment_taskId_technicianId_key` (`taskId`, `technicianId`),
  INDEX `MaintenanceTaskAssignment_taskId_idx` (`taskId`),
  INDEX `MaintenanceTaskAssignment_technicianId_idx` (`technicianId`),
  CONSTRAINT `MaintenanceTaskAssignment_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `MaintenanceTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `MaintenanceTaskAssignment_technicianId_fkey`
    FOREIGN KEY (`technicianId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `MaintenanceTaskAssignment` (`id`, `taskId`, `technicianId`, `assignedAt`)
SELECT CONCAT(`id`, '-a1'), `id`, `assignedTechId`, COALESCE(`createdAt`, CURRENT_TIMESTAMP(3))
FROM `MaintenanceTask`
WHERE `assignedTechId` IS NOT NULL;

INSERT IGNORE INTO `MaintenanceTaskAssignment` (`id`, `taskId`, `technicianId`, `assignedAt`)
SELECT CONCAT(`id`, '-a2'), `id`, `alternativeTechId`, COALESCE(`createdAt`, CURRENT_TIMESTAMP(3))
FROM `MaintenanceTask`
WHERE `alternativeTechId` IS NOT NULL AND (`assignedTechId` IS NULL OR `alternativeTechId` <> `assignedTechId`);

CREATE TABLE IF NOT EXISTS `MaintenanceAppointmentOption` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `token` VARCHAR(128) NOT NULL,
  `startTime` DATETIME(3) NOT NULL,
  `endTime` DATETIME(3) NOT NULL,
  `status` ENUM('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
  `sentAt` DATETIME(3) NULL,
  `respondedAt` DATETIME(3) NULL,
  `emailLogJson` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `MaintenanceAppointmentOption_token_key` (`token`),
  INDEX `MaintenanceAppointmentOption_taskId_idx` (`taskId`),
  INDEX `MaintenanceAppointmentOption_status_idx` (`status`),
  INDEX `MaintenanceAppointmentOption_startTime_endTime_idx` (`startTime`, `endTime`),
  CONSTRAINT `MaintenanceAppointmentOption_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `MaintenanceTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MaintenanceExpense` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `reportId` VARCHAR(191) NULL,
  `expenseType` VARCHAR(191) NOT NULL,
  `amount` DOUBLE NOT NULL DEFAULT 0,
  `description` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `MaintenanceExpense_taskId_idx` (`taskId`),
  INDEX `MaintenanceExpense_reportId_idx` (`reportId`),
  CONSTRAINT `MaintenanceExpense_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `MaintenanceTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `MaintenanceExpense_reportId_fkey`
    FOREIGN KEY (`reportId`) REFERENCES `MaintenanceReport`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Notification` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `recipientEmployeeId` VARCHAR(191) NULL,
  `type` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `message` TEXT NOT NULL,
  `linkUrl` VARCHAR(191) NULL,
  `metadata` JSON NULL,
  `isRead` BOOLEAN NOT NULL DEFAULT false,
  `readAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `Notification_tenantId_idx` (`tenantId`),
  INDEX `Notification_recipientEmployeeId_idx` (`recipientEmployeeId`),
  INDEX `Notification_isRead_createdAt_idx` (`isRead`, `createdAt`),
  CONSTRAINT `Notification_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `Notification_recipientEmployeeId_fkey`
    FOREIGN KEY (`recipientEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
