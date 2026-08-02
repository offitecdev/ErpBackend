-- Persist PDF-sized image derivatives separately from full-resolution originals.
-- Existing rows are populated lazily the first time they are used.
CREATE TABLE `PdfImageThumbnail` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(32) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `sourceVersion` VARCHAR(64) NULL,
    `imageUrl` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PdfImageThumbnail_tenantId_sourceType_sourceId_key`(`tenantId`, `sourceType`, `sourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
