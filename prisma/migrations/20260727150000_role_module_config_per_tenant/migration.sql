-- Roles become shared across the company tree; the module package moves from
-- a single column on Role to a per-entity table, so the same role can enable
-- different modules in each company (e.g. Offitec / Offitec AG / Offitec Group).
CREATE TABLE `RoleModuleConfig` (
    `roleId` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `moduleKeys` JSON NOT NULL,

    INDEX `RoleModuleConfig_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`roleId`, `tenantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RoleModuleConfig` ADD CONSTRAINT `RoleModuleConfig_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `RoleModuleConfig` ADD CONSTRAINT `RoleModuleConfig_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry over packages saved with the previous single-column model: they were
-- scoped to the role's own tenant.
INSERT INTO `RoleModuleConfig` (`roleId`, `tenantId`, `moduleKeys`)
SELECT `id`, `tenantId`, `moduleKeys` FROM `Role` WHERE `moduleKeys` IS NOT NULL;

ALTER TABLE `Role` DROP COLUMN `moduleKeys`;
