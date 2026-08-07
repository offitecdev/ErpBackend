-- Purchase-order status: "ORDERED" added, "UPDATED" removed (user request 2026-08-03).
--
-- `PurchaseOrder.status` is a free string column, so this migration only moves
-- existing rows onto the new vocabulary — no schema change is required.
--
--   PENDING  = order confirmed, supplier mail NOT sent yet ("Auftrag bestätigt")
--   ORDERED  = order mail actually sent to the supplier      ("Bestellt")
--
-- 1) UPDATED only ever existed for orders whose mail had already gone out and
--    whose content changed afterwards → those are placed orders (ORDERED); the
--    "updated" information lives on in `revision` (> 0) and is shown as a tag.
-- 2) PENDING rows that already carry an `emailSentAt` stamp were placed under
--    the old lifecycle as well → ORDERED.
--
-- Apply with: npx prisma migrate deploy

UPDATE `PurchaseOrder` SET `status` = 'ORDERED' WHERE `status` = 'UPDATED';

UPDATE `PurchaseOrder` SET `status` = 'ORDERED'
    WHERE `status` = 'PENDING' AND `emailSentAt` IS NOT NULL;
