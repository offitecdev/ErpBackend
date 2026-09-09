ALTER TABLE `SalesOrder` ADD COLUMN `addonDiscounts` LONGTEXT NULL;
ALTER TABLE `ProjectExtraMaterial` ADD COLUMN `documentLine` LONGTEXT NULL;
ALTER TABLE `ProjectExpense` ADD COLUMN `documentLine` LONGTEXT NULL;
ALTER TABLE `Invoice` ADD COLUMN `paymentStages` LONGTEXT NULL;
