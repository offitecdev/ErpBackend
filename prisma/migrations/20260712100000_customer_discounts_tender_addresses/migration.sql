-- Customer: default price list shown on the profile and used in offers.
ALTER TABLE `Customer`
    ADD COLUMN `priceList` VARCHAR(191) NULL;

-- Per-customer default discount (%) for a specific article. Applied automatically
-- when that article is added to a tender for the customer.
CREATE TABLE `CustomerProductDiscount` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NOT NULL,
    `discount` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CustomerProductDiscount_customerId_articleId_key`(`customerId`, `articleId`),
    INDEX `CustomerProductDiscount_tenantId_idx`(`tenantId`),
    INDEX `CustomerProductDiscount_articleId_idx`(`articleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CustomerProductDiscount`
    ADD CONSTRAINT `CustomerProductDiscount_customerId_fkey`
    FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tender: the Projektadresse (installation) becomes its own column;
-- deliveryAddress is from now on the actual Lieferadresse.
ALTER TABLE `Tender`
    ADD COLUMN `installationAddress` TEXT NULL;

-- Document-level direct discount (%) applied to the net total in the offer summary.
ALTER TABLE `Tender`
    ADD COLUMN `directDiscount` DOUBLE NULL DEFAULT 0;

-- Existing tenders used deliveryAddress as the Montage-/Projektadresse — carry it over.
UPDATE `Tender` SET `installationAddress` = `deliveryAddress` WHERE `installationAddress` IS NULL;
