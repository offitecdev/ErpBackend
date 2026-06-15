ALTER TABLE `Appointment`
  ADD COLUMN `assignedTechId` VARCHAR(191) NULL,
  ADD COLUMN `installationReminderSentAt` DATETIME(3) NULL,
  ADD INDEX `Appointment_assignedTechId_idx` (`assignedTechId`);

ALTER TABLE `Appointment`
  ADD CONSTRAINT `Appointment_assignedTechId_fkey`
  FOREIGN KEY (`assignedTechId`) REFERENCES `Employee`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ProjectReport`
  ADD COLUMN `signedAt` DATETIME(3) NULL;
