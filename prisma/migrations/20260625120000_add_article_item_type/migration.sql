-- Separates product/material identity from inventory: adds an item-type label on Article.
-- PRODUCT | MATERIAL — both share the same stock, supplier and average-cost processes.
-- Run with: npx prisma migrate deploy   (or `prisma db push` for dev)

ALTER TABLE `Article`
    ADD COLUMN `itemType` VARCHAR(191) NOT NULL DEFAULT 'PRODUCT';
