ALTER TABLE `Article`
  ADD COLUMN `salePrice` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `defaultSupplierId` VARCHAR(191) NULL;

CREATE TABLE `Supplier` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `companyName` VARCHAR(191) NOT NULL,
  `contactName` VARCHAR(191) NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `address` TEXT NULL,
  `notes` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ArticleSupplier` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `articleId` VARCHAR(191) NOT NULL,
  `supplierId` VARCHAR(191) NOT NULL,
  `locationId` VARCHAR(191) NULL,
  `supplierSku` VARCHAR(191) NULL,
  `purchasePrice` DOUBLE NOT NULL DEFAULT 0,
  `quantity` DOUBLE NOT NULL DEFAULT 0,
  `remainingQuantity` DOUBLE NOT NULL DEFAULT 0,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'CHF',
  `lastPurchaseDate` DATETIME(3) NULL,
  `stockMovementId` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `isPreferred` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `Supplier_tenantId_companyName_key` ON `Supplier`(`tenantId`, `companyName`);
CREATE INDEX `Supplier_tenantId_idx` ON `Supplier`(`tenantId`);

CREATE INDEX `ArticleSupplier_tenantId_idx` ON `ArticleSupplier`(`tenantId`);
CREATE INDEX `ArticleSupplier_articleId_idx` ON `ArticleSupplier`(`articleId`);
CREATE INDEX `ArticleSupplier_supplierId_idx` ON `ArticleSupplier`(`supplierId`);
CREATE INDEX `ArticleSupplier_locationId_idx` ON `ArticleSupplier`(`locationId`);

CREATE INDEX `PurchaseProposal_supplierId_idx` ON `PurchaseProposal`(`supplierId`);

ALTER TABLE `Supplier`
  ADD CONSTRAINT `Supplier_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ArticleSupplier`
  ADD CONSTRAINT `ArticleSupplier_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `ArticleSupplier_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ArticleSupplier_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ArticleSupplier_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `PurchaseProposal`
  ADD CONSTRAINT `PurchaseProposal_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
