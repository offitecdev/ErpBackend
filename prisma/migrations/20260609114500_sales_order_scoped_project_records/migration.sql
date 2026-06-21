ALTER TABLE `ProjectReport` ADD COLUMN `salesOrderId` VARCHAR(191) NULL;
ALTER TABLE `ProjectExpense` ADD COLUMN `salesOrderId` VARCHAR(191) NULL;
ALTER TABLE `Appointment` ADD COLUMN `salesOrderId` VARCHAR(191) NULL;
ALTER TABLE `ProjectExtraMaterial` ADD COLUMN `salesOrderId` VARCHAR(191) NULL;

CREATE INDEX `ProjectReport_salesOrderId_idx` ON `ProjectReport`(`salesOrderId`);
CREATE INDEX `ProjectExpense_salesOrderId_idx` ON `ProjectExpense`(`salesOrderId`);
CREATE INDEX `Appointment_salesOrderId_idx` ON `Appointment`(`salesOrderId`);
CREATE INDEX `ProjectExtraMaterial_salesOrderId_idx` ON `ProjectExtraMaterial`(`salesOrderId`);

ALTER TABLE `ProjectReport` ADD CONSTRAINT `ProjectReport_salesOrderId_fkey` FOREIGN KEY (`salesOrderId`) REFERENCES `SalesOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ProjectExpense` ADD CONSTRAINT `ProjectExpense_salesOrderId_fkey` FOREIGN KEY (`salesOrderId`) REFERENCES `SalesOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_salesOrderId_fkey` FOREIGN KEY (`salesOrderId`) REFERENCES `SalesOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ProjectExtraMaterial` ADD CONSTRAINT `ProjectExtraMaterial_salesOrderId_fkey` FOREIGN KEY (`salesOrderId`) REFERENCES `SalesOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
