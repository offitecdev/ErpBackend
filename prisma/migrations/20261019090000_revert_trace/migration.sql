-- Zurück in den Entwurf hinterlässt eine Spur (16.09.2026, Samet: «siparişi taslağa alınca
-- sipariş numarası kayboluyor ve hangi teklif olduğunu unutuyorum»).
--   Tender.reverted*              frühere AB-Nummer, wann, von wem, und das wartende Projekt
--   Appointment.detachedFromTenderId  angesetzte Termine bleiben stehen und hängen sich an den
--                                 Auftrag, der aus dieser Offerte wieder entsteht
-- Alles NULL-fähig: bestehende Zeilen und ältere Programmstände bleiben unberührt.

ALTER TABLE `Tender`
    ADD COLUMN `revertedOrderNumber` VARCHAR(191) NULL,
    ADD COLUMN `revertedAt` DATETIME(3) NULL,
    ADD COLUMN `revertedById` VARCHAR(191) NULL,
    ADD COLUMN `revertedProjectId` VARCHAR(191) NULL;

CREATE INDEX `Tender_tenantId_revertedProjectId_idx` ON `Tender`(`tenantId`, `revertedProjectId`);

ALTER TABLE `Appointment`
    ADD COLUMN `detachedFromTenderId` VARCHAR(191) NULL;

CREATE INDEX `Appointment_tenantId_detachedFromTenderId_idx` ON `Appointment`(`tenantId`, `detachedFromTenderId`);
