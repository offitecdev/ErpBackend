-- ÜRETİM › ÜRETİM TEDARİKÇİSİ (02.10.2026, Vorgabe Samet)
--
-- «Modül ayarları üretimde üretim tedarikçisi seç diye bir alan olsun …
--  seçilen tedarikçi seçilirse bizim üretim olan şirkette proje olarak açılsın.»
--
-- Nur HINZUGEFÜGT — ein älterer Stand des Servers läuft unverändert weiter
-- (die Namensgleichheit in shared/producerOrders.ts gilt weiter).
--
--   uretim_tedarikci_baglari  NEU  bestellende Firma + Lieferant → Produktionsfirma
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_tedarikci_baglari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `supplierId` VARCHAR(191) NOT NULL,
    `producerTenantId` VARCHAR(191) NOT NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_tedarikci_baglari_tenantId_producerTenantId_key`(`tenantId`, `producerTenantId`),
    UNIQUE INDEX `uretim_tedarikci_baglari_tenantId_supplierId_key`(`tenantId`, `supplierId`),
    INDEX `uretim_tedarikci_baglari_producerTenantId_idx`(`producerTenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
