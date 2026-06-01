CREATE TABLE `PositionMaterialMapping` (
    `id` VARCHAR(191) NOT NULL,
    `positionId` VARCHAR(191) NOT NULL,
    `materialId` VARCHAR(191) NOT NULL,
    `quantityMultiplier` DOUBLE NOT NULL DEFAULT 1,
    `discount` DOUBLE NULL DEFAULT 0,

    UNIQUE INDEX `PositionMaterialMapping_positionId_materialId_key`(`positionId`, `materialId`),
    INDEX `PositionMaterialMapping_materialId_idx`(`materialId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PositionMaterialMapping`
    ADD CONSTRAINT `PositionMaterialMapping_positionId_fkey`
    FOREIGN KEY (`positionId`) REFERENCES `Position`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PositionMaterialMapping`
    ADD CONSTRAINT `PositionMaterialMapping_materialId_fkey`
    FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
