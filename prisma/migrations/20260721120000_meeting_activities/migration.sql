-- Workspace meeting activities (meetings & tasks) with mixed staff/customer participants.
CREATE TABLE IF NOT EXISTS `MeetingActivity` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL DEFAULT 'MEETING',
  `title` VARCHAR(191) NOT NULL,
  `notes` TEXT NULL,
  `startTime` DATETIME(3) NOT NULL,
  `endTime` DATETIME(3) NOT NULL,
  `customerId` VARCHAR(191) NULL,
  `createdByEmployeeId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `MeetingActivity_tenantId_startTime_idx` ON `MeetingActivity`(`tenantId`, `startTime`);
CREATE INDEX `MeetingActivity_customerId_idx` ON `MeetingActivity`(`customerId`);
CREATE INDEX `MeetingActivity_createdByEmployeeId_idx` ON `MeetingActivity`(`createdByEmployeeId`);

ALTER TABLE `MeetingActivity`
  ADD CONSTRAINT `MeetingActivity_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `MeetingActivity`
  ADD CONSTRAINT `MeetingActivity_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `MeetingActivity`
  ADD CONSTRAINT `MeetingActivity_createdByEmployeeId_fkey`
  FOREIGN KEY (`createdByEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS `MeetingActivityParticipant` (
  `id` VARCHAR(191) NOT NULL,
  `meetingId` VARCHAR(191) NOT NULL,
  `participantType` VARCHAR(191) NOT NULL,
  `employeeId` VARCHAR(191) NULL,
  `customerId` VARCHAR(191) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `MeetingActivityParticipant_meetingId_idx` ON `MeetingActivityParticipant`(`meetingId`);
CREATE INDEX `MeetingActivityParticipant_employeeId_idx` ON `MeetingActivityParticipant`(`employeeId`);
CREATE INDEX `MeetingActivityParticipant_customerId_idx` ON `MeetingActivityParticipant`(`customerId`);

ALTER TABLE `MeetingActivityParticipant`
  ADD CONSTRAINT `MeetingActivityParticipant_meetingId_fkey`
  FOREIGN KEY (`meetingId`) REFERENCES `MeetingActivity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MeetingActivityParticipant`
  ADD CONSTRAINT `MeetingActivityParticipant_employeeId_fkey`
  FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `MeetingActivityParticipant`
  ADD CONSTRAINT `MeetingActivityParticipant_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
