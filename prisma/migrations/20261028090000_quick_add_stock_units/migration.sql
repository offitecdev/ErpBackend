-- Device identifiers are separate from reusable product/model barcodes.
-- Existing ArticleBarcode rows cannot safely be classified automatically.
CREATE TABLE `StockUnit` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NOT NULL,
    `barcode` VARCHAR(120) NOT NULL,
    `serialNumber` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `StockUnit_tenantId_barcode_key` (`tenantId`, `barcode`),
    UNIQUE INDEX `StockUnit_tenantId_serialNumber_key` (`tenantId`, `serialNumber`),
    INDEX `StockUnit_articleId_idx` (`articleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StockUnit` ADD CONSTRAINT `StockUnit_articleId_fkey`
    FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
