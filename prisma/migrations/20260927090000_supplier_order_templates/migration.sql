-- LIEFERANTEN-RECHENVORLAGE (07.09.2026, Vorgabe Samet).
--
-- Der Beleg-Import einer Bestellung (PDF / Foto / Tabelle) ordnet Spalten nicht
-- mehr von Hand zu. Was danach kommt, ist die RECHENSTUFE: gestaffelte Rabatte,
-- Steuersatz, und ab welcher Menge welcher Preis gilt. Diese Einstellung gehört
-- dem LIEFERANTEN und wird beim nächsten Beleg desselben Lieferanten von selbst
-- wieder vorgeschlagen — dafür ist diese Tabelle da.
--
-- `supplierId` NULL = allgemeine Vorlage (steht bei jedem Lieferanten in der
-- Liste). `config` ist JSON, weil die Einstellung mit jedem Lieferanten wächst
-- und eine Wanderung je Feld die falsche Rechnung wäre.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE IF NOT EXISTS `SupplierOrderTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `supplierId` VARCHAR(191) NULL,
    `supplierName` VARCHAR(191) NOT NULL DEFAULT '',
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `config` TEXT NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `usageCount` INTEGER NOT NULL DEFAULT 0,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `SupplierOrderTemplate_tenantId_idx` ON `SupplierOrderTemplate`(`tenantId`);
CREATE INDEX `SupplierOrderTemplate_tenantId_supplierId_idx` ON `SupplierOrderTemplate`(`tenantId`, `supplierId`);
