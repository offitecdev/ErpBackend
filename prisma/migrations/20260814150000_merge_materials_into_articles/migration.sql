-- Merge the legacy `Material` table into `Article` and repurpose `Article.itemType`
-- as the product/service classification (PRODUCT | SERVICE). Apply with:
--   npx prisma migrate deploy
--
-- Design notes:
--  * Legacy Material rows are copied into Article KEEPING THEIR IDS, so every
--    referencing row (ReportMaterial, ProjectExtraMaterial, ProjectVariation,
--    TenderMaterialUsage, SupplyRequest snapshots) repoints without value changes —
--    the columns are only renamed/re-constrained.
--  * Material.unitCost historically doubled as sale price (search-items mapped it
--    to salePrice) and as cost (ReportMaterial.costAtTime) — it is copied into BOTH
--    baseCost and salePrice.
--  * Material.stockQuantity was a scalar; Article stock lives in StockBalance +
--    StockMovement. Each migrated non-zero stock becomes a balance at the tenant's
--    main warehouse plus one IN movement for the audit trail / weighted-average cost
--    (movement skipped when the tenant has no employee to attribute it to).
--  * PositionMaterialMapping was write-dead (no creator since the article-mapping
--    rework) and is dropped outright.

-- 1. Tenants that hold legacy material stock need a main warehouse to book it into.
INSERT INTO `Location` (`id`, `tenantId`, `parentLocationId`, `locationName`, `locationType`, `isActive`)
SELECT CONCAT('migloc-', t.`tenantId`), t.`tenantId`, NULL, 'Ana Depo', 'MAIN_WAREHOUSE', 1
FROM (SELECT DISTINCT `tenantId` FROM `Material` WHERE `stockQuantity` <> 0) t
WHERE NOT EXISTS (
    SELECT 1 FROM `Location` l
    WHERE l.`tenantId` = t.`tenantId` AND l.`locationType` = 'MAIN_WAREHOUSE'
);

-- 2. Copy legacy materials into Article (ids preserved). serialId was globally
--    unique; Article codes are unique per tenant — on a code clash the migrated
--    row gets a deterministic '-M-<id>' suffix. Inactive materials arrive
--    soft-deleted (deletedAt) so they do not resurface in the product list.
INSERT INTO `Article`
    (`id`, `tenantId`, `articleCode`, `name`, `baseCost`, `salePrice`, `unit`,
     `imageUrl`, `itemType`, `status`, `isActive`, `minStockLevel`,
     `criticalStockLevel`, `createdAt`, `updatedAt`, `deletedAt`)
SELECT
    m.`id`, m.`tenantId`,
    CASE WHEN EXISTS (
        SELECT 1 FROM `Article` a
        WHERE a.`tenantId` = m.`tenantId` AND a.`articleCode` = m.`serialId`
    ) THEN CONCAT(m.`serialId`, '-M-', m.`id`) ELSE m.`serialId` END,
    m.`name`, m.`unitCost`, m.`unitCost`, 'Adet',
    m.`imageUrl`, 'PRODUCT', 'ACTIVE', m.`isActive`, m.`minStockLevel`,
    m.`criticalStockLevel`, m.`createdAt`, m.`updatedAt`,
    CASE WHEN m.`isActive` = 1 THEN NULL ELSE NOW() END
FROM `Material` m
WHERE m.`id` NOT IN (SELECT `id` FROM `Article`);

-- 3. Opening balances for migrated stock at the tenant's main warehouse.
INSERT INTO `StockBalance` (`id`, `tenantId`, `articleId`, `locationId`, `currentQuantity`, `reservedQuantity`, `updatedAt`)
SELECT
    CONCAT('migb-', m.`id`), m.`tenantId`, m.`id`,
    (SELECT l.`id` FROM `Location` l
     WHERE l.`tenantId` = m.`tenantId` AND l.`locationType` = 'MAIN_WAREHOUSE'
     ORDER BY l.`locationName` ASC LIMIT 1),
    m.`stockQuantity`, 0, NOW()
FROM `Material` m
WHERE m.`stockQuantity` <> 0
  AND NOT EXISTS (SELECT 1 FROM `StockBalance` b WHERE b.`articleId` = m.`id`);

-- 4. Audit trail: one IN movement per migrated positive stock, attributed to the
--    tenant's first (preferably active) employee. unitCost feeds the weighted
--    average; zero-cost materials leave it NULL.
INSERT INTO `StockMovement`
    (`id`, `tenantId`, `articleId`, `movementType`, `quantity`, `unitCost`,
     `sourceLocationId`, `destinationLocationId`, `transactionDate`, `employeeId`,
     `supplierId`, `referenceId`, `description`)
SELECT
    CONCAT('migm-', m.`id`), m.`tenantId`, m.`id`, 'IN', m.`stockQuantity`,
    CASE WHEN m.`unitCost` > 0 THEN m.`unitCost` ELSE NULL END,
    NULL,
    (SELECT l.`id` FROM `Location` l
     WHERE l.`tenantId` = m.`tenantId` AND l.`locationType` = 'MAIN_WAREHOUSE'
     ORDER BY l.`locationName` ASC LIMIT 1),
    NOW(),
    (SELECT e.`id` FROM `Employee` e
     WHERE e.`tenantId` = m.`tenantId`
     ORDER BY (e.`deletedAt` IS NULL) DESC, e.`id` ASC LIMIT 1),
    NULL, NULL, 'Malzeme birleştirme aktarımı'
FROM `Material` m
WHERE m.`stockQuantity` > 0
  AND EXISTS (SELECT 1 FROM `Employee` e WHERE e.`tenantId` = m.`tenantId`)
  AND NOT EXISTS (SELECT 1 FROM `StockMovement` s WHERE s.`id` = CONCAT('migm-', m.`id`));

-- 5. Articles created under the old MATERIAL screen become plain products.
--    itemType now means PRODUCT | SERVICE.
UPDATE `Article` SET `itemType` = 'PRODUCT' WHERE `itemType` = 'MATERIAL';

-- 6. ReportMaterial: the article column takes over (writes used materialId until
--    now; ids are preserved so a straight copy suffices), legacy column dropped.
UPDATE `ReportMaterial` SET `articleId` = `materialId`
WHERE `materialId` IS NOT NULL AND `articleId` IS NULL;
ALTER TABLE `ReportMaterial` DROP FOREIGN KEY IF EXISTS `ReportMaterial_materialId_fkey`;
ALTER TABLE `ReportMaterial` DROP COLUMN `materialId`;

-- 7. ProjectExtraMaterial: repoint at Article under the new column name.
ALTER TABLE `ProjectExtraMaterial` DROP FOREIGN KEY IF EXISTS `ProjectExtraMaterial_materialId_fkey`;
ALTER TABLE `ProjectExtraMaterial` CHANGE `materialId` `articleId` VARCHAR(191) NOT NULL;
ALTER TABLE `ProjectExtraMaterial` DROP INDEX IF EXISTS `ProjectExtraMaterial_materialId_idx`;
ALTER TABLE `ProjectExtraMaterial` ADD INDEX `ProjectExtraMaterial_articleId_idx`(`articleId`);
ALTER TABLE `ProjectExtraMaterial`
    ADD CONSTRAINT `ProjectExtraMaterial_articleId_fkey`
    FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. ProjectVariation: same repoint.
ALTER TABLE `ProjectVariation` DROP FOREIGN KEY IF EXISTS `ProjectVariation_materialId_fkey`;
ALTER TABLE `ProjectVariation` CHANGE `materialId` `articleId` VARCHAR(191) NOT NULL;
ALTER TABLE `ProjectVariation`
    ADD CONSTRAINT `ProjectVariation_articleId_fkey`
    FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9. TenderMaterialUsage: same repoint (still actively written by the quote UI).
ALTER TABLE `TenderMaterialUsage` DROP FOREIGN KEY IF EXISTS `TenderMaterialUsage_materialId_fkey`;
ALTER TABLE `TenderMaterialUsage` CHANGE `materialId` `articleId` VARCHAR(191) NOT NULL;
ALTER TABLE `TenderMaterialUsage` DROP INDEX IF EXISTS `TenderMaterialUsage_materialId_idx`;
ALTER TABLE `TenderMaterialUsage` ADD INDEX `TenderMaterialUsage_articleId_idx`(`articleId`);
ALTER TABLE `TenderMaterialUsage`
    ADD CONSTRAINT `TenderMaterialUsage_articleId_fkey`
    FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10. PositionMaterialMapping: write-dead legacy mapping — dropped with the merge.
DROP TABLE IF EXISTS `PositionMaterialMapping`;

-- 11. SupplyRequest snapshots: fold materialId into articleId, single item type.
UPDATE `SupplyRequest`
SET `articleId` = COALESCE(`articleId`, `materialId`), `itemType` = 'PRODUCT';
ALTER TABLE `SupplyRequest` DROP COLUMN IF EXISTS `materialId`;

-- 12. The legacy table goes away.
DROP TABLE IF EXISTS `Material`;
