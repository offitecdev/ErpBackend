CREATE TABLE `TenderMaterialUsage` (
    `id` VARCHAR(191) NOT NULL,
    `tenderId` VARCHAR(191) NOT NULL,
    `materialId` VARCHAR(191) NOT NULL,
    `quantity` DOUBLE NOT NULL,
    `unitCost` DOUBLE NOT NULL DEFAULT 0,
    `description` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TenderMaterialUsage_tenderId_idx`(`tenderId`),
    INDEX `TenderMaterialUsage_materialId_idx`(`materialId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TenderMaterialUsage`
    ADD CONSTRAINT `TenderMaterialUsage_tenderId_fkey`
    FOREIGN KEY (`tenderId`) REFERENCES `Tender`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TenderMaterialUsage`
    ADD CONSTRAINT `TenderMaterialUsage_materialId_fkey`
    FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
