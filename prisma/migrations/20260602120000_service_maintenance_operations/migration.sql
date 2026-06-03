ALTER TABLE `MaintenanceContract`
    ADD COLUMN `serviceScope` TEXT NULL,
    ADD COLUMN `siteName` VARCHAR(191) NULL,
    ADD COLUMN `reminderDaysBefore` INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN `notificationChannels` JSON NULL;

ALTER TABLE `MaintenanceTask`
    ADD COLUMN `alternativeTechId` VARCHAR(191) NULL,
    ADD COLUMN `siteName` VARCHAR(191) NULL,
    ADD COLUMN `assignmentHistoryJson` JSON NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ADD INDEX `MaintenanceTask_alternativeTechId_idx`(`alternativeTechId`),
    ADD INDEX `MaintenanceTask_plannedDate_idx`(`plannedDate`);

ALTER TABLE `MaintenanceTask`
    ADD CONSTRAINT `MaintenanceTask_alternativeTechId_fkey`
    FOREIGN KEY (`alternativeTechId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MaintenanceReport`
    ADD COLUMN `riskNotes` TEXT NULL,
    ADD COLUMN `fileUrls` JSON NULL,
    ADD COLUMN `signedAt` DATETIME(3) NULL,
    ADD COLUMN `lockedAt` DATETIME(3) NULL,
    ADD COLUMN `pdfUrl` VARCHAR(191) NULL,
    ADD COLUMN `emailSentAt` DATETIME(3) NULL,
    ADD COLUMN `emailLogJson` JSON NULL;

ALTER TABLE `MaintenanceMaterial`
    ADD COLUMN `sourceLocationId` VARCHAR(191) NULL;

ALTER TABLE `ServiceCall`
    ADD COLUMN `alternativeTechId` VARCHAR(191) NULL,
    ADD COLUMN `siteName` VARCHAR(191) NULL,
    ADD COLUMN `priority` VARCHAR(191) NULL,
    ADD COLUMN `assignmentHistoryJson` JSON NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ADD INDEX `ServiceCall_alternativeTechId_idx`(`alternativeTechId`);

ALTER TABLE `ServiceCall`
    ADD CONSTRAINT `ServiceCall_alternativeTechId_fkey`
    FOREIGN KEY (`alternativeTechId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ServiceReport`
    ADD COLUMN `observations` TEXT NULL,
    ADD COLUMN `recommendations` TEXT NULL,
    ADD COLUMN `beforePhotoUrls` JSON NULL,
    ADD COLUMN `afterPhotoUrls` JSON NULL,
    ADD COLUMN `fileUrls` JSON NULL,
    ADD COLUMN `signedAt` DATETIME(3) NULL,
    ADD COLUMN `lockedAt` DATETIME(3) NULL;

ALTER TABLE `ServiceMaterial`
    ADD COLUMN `sourceLocationId` VARCHAR(191) NULL;
