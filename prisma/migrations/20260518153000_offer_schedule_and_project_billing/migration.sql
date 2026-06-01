ALTER TABLE `Tender`
  ADD COLUMN IF NOT EXISTS `offerMailSentAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `offerAcceptedAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `offerMailRecipient` VARCHAR(191) NULL,
  ADD COLUMN IF NOT EXISTS `offerAcceptanceToken` VARCHAR(128) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `Tender_offerAcceptanceToken_key` ON `Tender`(`offerAcceptanceToken`);

ALTER TABLE `Project`
  ADD COLUMN IF NOT EXISTS `overtimeHourlyRate` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `overtimeTolerancePercent` DOUBLE NOT NULL DEFAULT 15;

ALTER TABLE `ProjectReport`
  ADD COLUMN IF NOT EXISTS `workDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS `startedAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `endedAt` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `plannedMinutesForDay` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `overtimeMinutes` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `overtimeHourlyRate` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `overtimeCost` DOUBLE NOT NULL DEFAULT 0;

ALTER TABLE `Appointment`
  ADD COLUMN IF NOT EXISTS `isLocked` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS `OfferScheduleSlot` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `tenderId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `startTime` DATETIME(3) NOT NULL,
  `endTime` DATETIME(3) NOT NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `OfferScheduleSlot_tenantId_idx` (`tenantId`),
  INDEX `OfferScheduleSlot_tenderId_idx` (`tenderId`),
  INDEX `OfferScheduleSlot_customerId_idx` (`customerId`),
  INDEX `OfferScheduleSlot_startTime_endTime_idx` (`startTime`, `endTime`),
  CONSTRAINT `OfferScheduleSlot_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `OfferScheduleSlot_tenderId_fkey` FOREIGN KEY (`tenderId`) REFERENCES `Tender`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `OfferScheduleSlot_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `ProjectExtraMaterial` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `materialId` VARCHAR(191) NOT NULL,
  `quantity` DOUBLE NOT NULL,
  `unitPrice` DOUBLE NOT NULL,
  `description` TEXT NULL,
  `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ProjectExtraMaterial_projectId_idx` (`projectId`),
  INDEX `ProjectExtraMaterial_materialId_idx` (`materialId`),
  CONSTRAINT `ProjectExtraMaterial_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ProjectExtraMaterial_materialId_fkey` FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);
