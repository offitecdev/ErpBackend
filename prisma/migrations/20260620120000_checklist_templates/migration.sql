CREATE TABLE IF NOT EXISTS `ChecklistTemplate` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `items` JSON NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `ChecklistTemplate_tenantId_idx` ON `ChecklistTemplate`(`tenantId`);

ALTER TABLE `ChecklistTemplate`
  ADD CONSTRAINT `ChecklistTemplate_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
