-- FİYAT TALEBİNDE ÇOK TEDARİKÇİ (25.09.2026): JSON [{supplierId, supplierName,
-- supplierEmail, supplierAddress, emailSentAt, emailRecipient}]. NULL = tek
-- tedarikçi (supplier* sütunları) ya da hiç. İlk kayıt supplier* sütunlarına da yazılır.
ALTER TABLE `PurchaseOrder` ADD COLUMN `requestSuppliers` TEXT NULL;
