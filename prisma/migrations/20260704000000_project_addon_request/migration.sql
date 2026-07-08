-- Technicians can no longer create Zusatzaufträge (addon orders) directly. When a
-- technician finishes a montage with extra work, a PENDING request is recorded here
-- and surfaced in the manager's "additional order" section; the manager creates the
-- actual addon order, which flips matching requests to HANDLED.
CREATE TABLE `ProjectAddonRequest` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `salesOrderId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `requestedByName` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `note` TEXT NULL,
    `expenseTotal` DOUBLE NOT NULL DEFAULT 0,
    `materialTotal` DOUBLE NOT NULL DEFAULT 0,
    `overtimeTotal` DOUBLE NOT NULL DEFAULT 0,
    `total` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedById` VARCHAR(191) NULL,
    `resolvedAt` DATETIME(3) NULL,

    INDEX `ProjectAddonRequest_tenantId_idx`(`tenantId`),
    INDEX `ProjectAddonRequest_projectId_idx`(`projectId`),
    INDEX `ProjectAddonRequest_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProjectAddonRequest` ADD CONSTRAINT `ProjectAddonRequest_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
