ALTER TABLE `SalesOrder` DROP FOREIGN KEY `SalesOrder_tenderId_fkey`;

DROP INDEX `SalesOrder_tenderId_key` ON `SalesOrder`;

ALTER TABLE `SalesOrder`
    MODIFY `tenderId` VARCHAR(191) NULL,
    ADD COLUMN `parentSalesOrderId` VARCHAR(191) NULL,
    ADD COLUMN `revisionNumber` INTEGER NULL;

CREATE UNIQUE INDEX `SalesOrder_tenderId_key` ON `SalesOrder`(`tenderId`);
CREATE INDEX `SalesOrder_parentSalesOrderId_idx` ON `SalesOrder`(`parentSalesOrderId`);

ALTER TABLE `SalesOrder`
    ADD CONSTRAINT `SalesOrder_tenderId_fkey`
    FOREIGN KEY (`tenderId`) REFERENCES `Tender`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `SalesOrder`
    ADD CONSTRAINT `SalesOrder_parentSalesOrderId_fkey`
    FOREIGN KEY (`parentSalesOrderId`) REFERENCES `SalesOrder`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
