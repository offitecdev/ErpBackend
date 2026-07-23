-- Add real creation/update timestamps to Material for deterministic
-- newest/oldest sorting (mirrors the earlier Article change).
ALTER TABLE `Material`
    ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE INDEX `Material_tenantId_createdAt_idx`
    ON `Material`(`tenantId`, `createdAt`);
