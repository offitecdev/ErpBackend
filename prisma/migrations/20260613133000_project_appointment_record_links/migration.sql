ALTER TABLE `ProjectReport`
  ADD COLUMN IF NOT EXISTS `appointmentId` VARCHAR(191) NULL;

ALTER TABLE `ProjectExpense`
  ADD COLUMN IF NOT EXISTS `appointmentId` VARCHAR(191) NULL;

ALTER TABLE `ProjectExtraMaterial`
  ADD COLUMN IF NOT EXISTS `appointmentId` VARCHAR(191) NULL;

CREATE INDEX `ProjectReport_appointmentId_idx` ON `ProjectReport`(`appointmentId`);
CREATE INDEX `ProjectExpense_appointmentId_idx` ON `ProjectExpense`(`appointmentId`);
CREATE INDEX `ProjectExtraMaterial_appointmentId_idx` ON `ProjectExtraMaterial`(`appointmentId`);

ALTER TABLE `ProjectReport`
  ADD CONSTRAINT `ProjectReport_appointmentId_fkey`
  FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ProjectExpense`
  ADD CONSTRAINT `ProjectExpense_appointmentId_fkey`
  FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ProjectExtraMaterial`
  ADD CONSTRAINT `ProjectExtraMaterial_appointmentId_fkey`
  FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
