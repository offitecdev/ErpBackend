-- Add real creation/update timestamps for deterministic newest/oldest sorting.
-- `deletedAt` turns product deletion into a recoverable move to trash.
ALTER TABLE `Article`
    ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `deletedAt` DATETIME(3) NULL;

CREATE INDEX `Article_tenantId_deletedAt_createdAt_idx`
    ON `Article`(`tenantId`, `deletedAt`, `createdAt`);
