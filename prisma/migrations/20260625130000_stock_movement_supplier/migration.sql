-- Adds an optional supplier reference to stock movements so inbound/purchase
-- movements can record which supplier the goods came from.
-- Run with: npx prisma migrate deploy

ALTER TABLE `StockMovement`
    ADD COLUMN `supplierId` VARCHAR(191) NULL;

CREATE INDEX `StockMovement_supplierId_idx` ON `StockMovement`(`supplierId`);

ALTER TABLE `StockMovement`
    ADD CONSTRAINT `StockMovement_supplierId_fkey`
    FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
