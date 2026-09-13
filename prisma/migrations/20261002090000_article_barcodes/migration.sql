-- Weitere Barcodes je Artikel (Schnellerfassung, 10.09.2026): dasselbe Modell
-- kann je Lieferant/Charge ein anderes Etikett tragen.
CREATE TABLE `ArticleBarcode` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NOT NULL,
    `barcode` VARCHAR(120) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ArticleBarcode_tenantId_barcode_key`(`tenantId`, `barcode`),
    INDEX `ArticleBarcode_articleId_idx`(`articleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ArticleBarcode`
    ADD CONSTRAINT `ArticleBarcode_articleId_fkey`
    FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
