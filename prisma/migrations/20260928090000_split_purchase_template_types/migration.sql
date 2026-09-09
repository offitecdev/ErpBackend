-- Rechenvorlagen fuer Bestellungen und Preisanfragen sind zwei getrennte Listen.
-- Bestehende Vorlagen gehoeren weiterhin zur Bestellung; Preisanfragen starten
-- mit ihrer eigenen, leeren Liste.
ALTER TABLE `SupplierOrderTemplate`
    ADD COLUMN `documentType` VARCHAR(32) NOT NULL DEFAULT 'ORDER';

CREATE INDEX `SupplierOrderTemplate_tenantId_documentType_idx`
    ON `SupplierOrderTemplate`(`tenantId`, `documentType`);
