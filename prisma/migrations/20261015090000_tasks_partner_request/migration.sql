-- Görevler: Ortak-ekle-Anfrage (15.09.2026, Samet) — nur die Administratorrolle weist zu;
-- alle anderen beantragen EINE weitere Person je Anfrage.
ALTER TABLE `Task`
    ADD COLUMN `partnerRequestedById` VARCHAR(191) NULL,
    ADD COLUMN `partnerRequestEmployeeId` VARCHAR(191) NULL,
    ADD COLUMN `partnerRequestedAt` DATETIME(3) NULL;

CREATE INDEX `Task_tenantId_partnerRequestedAt_idx` ON `Task`(`tenantId`, `partnerRequestedAt`);
