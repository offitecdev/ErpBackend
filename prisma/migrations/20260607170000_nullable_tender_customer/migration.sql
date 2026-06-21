ALTER TABLE `Tender` DROP FOREIGN KEY `Tender_customerId_fkey`;

ALTER TABLE `Tender`
  MODIFY `customerId` VARCHAR(191) NULL;

ALTER TABLE `Tender`
  ADD CONSTRAINT `Tender_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
