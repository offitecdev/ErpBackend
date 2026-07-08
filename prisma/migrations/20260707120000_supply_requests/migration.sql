-- Supply Requests module: material stock thresholds + SupplyRequest table.
-- Run with: npx prisma migrate deploy

-- Materials gain minimum / critical stock levels (Articles already have them).
ALTER TABLE `Material`
  ADD COLUMN `minStockLevel` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `criticalStockLevel` DOUBLE NOT NULL DEFAULT 0;

-- Supply request records (email a supplier when an item hits min/critical stock).
CREATE TABLE `SupplyRequest` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `itemType` VARCHAR(191) NOT NULL DEFAULT 'PRODUCT',
  `articleId` VARCHAR(191) NULL,
  `materialId` VARCHAR(191) NULL,
  `itemName` VARCHAR(191) NOT NULL,
  `itemCode` VARCHAR(191) NULL,
  `unit` VARCHAR(191) NULL,
  `supplierId` VARCHAR(191) NULL,
  `supplierName` VARCHAR(191) NULL,
  `supplierEmail` VARCHAR(191) NULL,
  `requestedQuantity` DOUBLE NOT NULL DEFAULT 0,
  `emailSubject` TEXT NULL,
  `emailBody` TEXT NULL,
  `emailSent` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `createdByEmpId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `receivedAt` DATETIME(3) NULL,
  `receivedByEmpId` VARCHAR(191) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `SupplyRequest_tenantId_idx` ON `SupplyRequest`(`tenantId`);
CREATE INDEX `SupplyRequest_status_idx` ON `SupplyRequest`(`status`);
CREATE INDEX `SupplyRequest_articleId_idx` ON `SupplyRequest`(`articleId`);
CREATE INDEX `SupplyRequest_supplierId_idx` ON `SupplyRequest`(`supplierId`);
