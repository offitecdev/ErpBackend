CREATE TABLE `SalesOrder` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NULL,
  `tenderId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `orderNumber` VARCHAR(191) NOT NULL,
  `orderType` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'ORDERED',
  `totalAmount` DOUBLE NOT NULL DEFAULT 0,
  `createdByEmployeeId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `SalesOrder_tenderId_key`(`tenderId`),
  INDEX `SalesOrder_tenantId_idx`(`tenantId`),
  INDEX `SalesOrder_customerId_idx`(`customerId`),
  INDEX `SalesOrder_projectId_idx`(`projectId`),
  INDEX `SalesOrder_createdByEmployeeId_idx`(`createdByEmployeeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SalesOrder`
  ADD CONSTRAINT `SalesOrder_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesOrder_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesOrder_tenderId_fkey` FOREIGN KEY (`tenderId`) REFERENCES `Tender`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesOrder_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesOrder_createdByEmployeeId_fkey` FOREIGN KEY (`createdByEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
