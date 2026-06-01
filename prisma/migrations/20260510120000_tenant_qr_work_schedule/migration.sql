-- AlterTable
ALTER TABLE `Tenant` ADD COLUMN `checkInQrSecret` VARCHAR(512) NULL;
ALTER TABLE `Tenant` ADD COLUMN `checkOutQrSecret` VARCHAR(512) NULL;
ALTER TABLE `Tenant` ADD COLUMN `workScheduleJson` JSON NULL;
