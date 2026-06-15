-- AlterTable: per-movement unit cost for manual stock-ins (feeds weighted-average cost)
ALTER TABLE `StockMovement`
  ADD COLUMN `unitCost` DOUBLE NULL;