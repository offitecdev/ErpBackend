-- Company categories ("Numara" profiles): an admin-defined bundle of module
-- keys per company tree. Tenants map to at most one profile; the profile
-- decides which modules that company exposes.
CREATE TABLE `ModuleProfile` (
    `id` VARCHAR(191) NOT NULL,
    `rootTenantId` VARCHAR(191) NOT NULL,
    `profileNumber` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `moduleKeys` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ModuleProfile_rootTenantId_profileNumber_key`(`rootTenantId`, `profileNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Tenant` ADD COLUMN `moduleProfileId` VARCHAR(191) NULL;

ALTER TABLE `Tenant` ADD CONSTRAINT `Tenant_moduleProfileId_fkey` FOREIGN KEY (`moduleProfileId`) REFERENCES `ModuleProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
