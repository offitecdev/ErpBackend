-- Adds the stock-card specific columns required by the new Stock & Inventory module
-- Run with: npx prisma migrate deploy   (or `prisma db push` for dev)

ALTER TABLE `Article`
    ADD COLUMN `category` VARCHAR(191) NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN `lastPurchaseDate` DATETIME(3) NULL;

-- Widen imageUrl to support base64 data URLs
ALTER TABLE `Article`
    MODIFY COLUMN `imageUrl` TEXT NULL;
