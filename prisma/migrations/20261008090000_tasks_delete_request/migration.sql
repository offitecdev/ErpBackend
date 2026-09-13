-- Görevler: Löschanfrage (13.09.2026, Samet) — nur Admins löschen, alle anderen beantragen.
ALTER TABLE `Task`
    ADD COLUMN `deleteRequestedById` VARCHAR(191) NULL,
    ADD COLUMN `deleteRequestedAt` DATETIME(3) NULL,
    ADD COLUMN `deleteRequestNote` TEXT NULL;

CREATE INDEX `Task_tenantId_deleteRequestedAt_idx` ON `Task`(`tenantId`, `deleteRequestedAt`);
