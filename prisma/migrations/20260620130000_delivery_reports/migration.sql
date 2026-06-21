CREATE TABLE IF NOT EXISTS `DeliveryReport` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `salesOrderId` VARCHAR(191) NULL,
  `appointmentId` VARCHAR(191) NULL,
  `employeeId` VARCHAR(191) NULL,
  `checklistTemplateId` VARCHAR(191) NULL,
  `checklistName` VARCHAR(191) NULL,
  `responses` JSON NOT NULL,
  `notes` TEXT NULL,
  `customerSignature` LONGTEXT NULL,
  `isSigned` BOOLEAN NOT NULL DEFAULT false,
  `signedAt` DATETIME(3) NULL,
  `sentAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `DeliveryReport_tenantId_idx` ON `DeliveryReport`(`tenantId`);
CREATE INDEX `DeliveryReport_appointmentId_idx` ON `DeliveryReport`(`appointmentId`);
CREATE INDEX `DeliveryReport_projectId_idx` ON `DeliveryReport`(`projectId`);
CREATE INDEX `DeliveryReport_salesOrderId_idx` ON `DeliveryReport`(`salesOrderId`);

ALTER TABLE `DeliveryReport`
  ADD CONSTRAINT `DeliveryReport_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
