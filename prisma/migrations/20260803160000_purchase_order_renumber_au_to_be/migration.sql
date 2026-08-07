-- Renumber the orders that were created during the one-day "AU-" window
-- (user request 2026-08-03: "change AU-2026-001 to BE-2026-001").
--
-- The prefix is the only thing that changes — AU-2026-001 becomes BE-2026-001,
-- the year and the sequence number are kept exactly as they are, so an order
-- keeps its position in the series.
--
-- ⚠ A row is SKIPPED when its target code is already taken inside the same
-- tenant (`@@unique([tenantId, referenceNumber])`), so the statement can never
-- fail on a duplicate and is safe to run twice. Such an order keeps its AU-
-- code and can be renumbered by hand in the order-details sheet (the field is
-- user-editable).
--
-- ⚠ PDFs that were already e-mailed to a supplier carry the OLD number — this
-- only rewrites the record.
--
-- Apply with: npx prisma migrate deploy

UPDATE `PurchaseOrder` `po`
SET `po`.`referenceNumber` = CONCAT('BE-', SUBSTRING(`po`.`referenceNumber`, 4))
WHERE `po`.`referenceNumber` LIKE 'AU-%'
  AND NOT EXISTS (
      SELECT 1 FROM (SELECT `tenantId`, `referenceNumber` FROM `PurchaseOrder`) `other`
      WHERE `other`.`tenantId` = `po`.`tenantId`
        AND `other`.`referenceNumber` = CONCAT('BE-', SUBSTRING(`po`.`referenceNumber`, 4))
  );
