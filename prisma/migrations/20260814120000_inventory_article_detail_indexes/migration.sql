-- Product detail opens stock movements and supplier cost rows by tenant + article.
-- Composite indexes avoid scanning unrelated tenants/articles and support the
-- movement list's newest-first order.
--
-- Apply with: npx prisma migrate deploy

CREATE INDEX `StockMovement_tenantId_articleId_transactionDate_id_idx`
    ON `StockMovement`(`tenantId`, `articleId`, `transactionDate`, `id`);

CREATE INDEX `StockMovement_tenantId_articleId_movementType_supplierId_idx`
    ON `StockMovement`(`tenantId`, `articleId`, `movementType`, `supplierId`);

CREATE INDEX `ArticleSupplier_tenantId_articleId_idx`
    ON `ArticleSupplier`(`tenantId`, `articleId`);

CREATE INDEX `Article_tenantId_itemType_deletedAt_createdAt_id_idx`
    ON `Article`(`tenantId`, `itemType`, `deletedAt`, `createdAt`, `id`);
