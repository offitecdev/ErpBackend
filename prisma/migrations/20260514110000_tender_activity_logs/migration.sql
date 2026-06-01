CREATE TABLE `TenderActivityLog` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `tenderId` VARCHAR(191) NOT NULL,
    `positionId` VARCHAR(191) NULL,
    `mappingId` VARCHAR(191) NULL,
    `articleId` VARCHAR(191) NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `actionType` VARCHAR(191) NOT NULL,
    `fieldName` VARCHAR(191) NULL,
    `oldValue` TEXT NULL,
    `newValue` TEXT NULL,
    `description` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `TenderActivityLog_tenantId_idx` ON `TenderActivityLog`(`tenantId`);
CREATE INDEX `TenderActivityLog_tenderId_idx` ON `TenderActivityLog`(`tenderId`);
CREATE INDEX `TenderActivityLog_positionId_idx` ON `TenderActivityLog`(`positionId`);
CREATE INDEX `TenderActivityLog_mappingId_idx` ON `TenderActivityLog`(`mappingId`);
CREATE INDEX `TenderActivityLog_articleId_idx` ON `TenderActivityLog`(`articleId`);
