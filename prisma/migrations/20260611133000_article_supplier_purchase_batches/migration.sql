ALTER TABLE `ArticleSupplier`
  ADD COLUMN `locationId` VARCHAR(191) NULL,
  ADD COLUMN `quantity` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `remainingQuantity` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `stockMovementId` VARCHAR(191) NULL;

DROP INDEX `ArticleSupplier_articleId_supplierId_key` ON `ArticleSupplier`;

CREATE INDEX `ArticleSupplier_locationId_idx` ON `ArticleSupplier`(`locationId`);

ALTER TABLE `ArticleSupplier`
  ADD CONSTRAINT `ArticleSupplier_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
