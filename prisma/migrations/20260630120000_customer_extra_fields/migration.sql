-- Add extra customer profile fields:
-- mobile phone, website, preferred language (TR/EN/DE), VAT number,
-- customer source and problematic departments.
ALTER TABLE `Customer`
    ADD COLUMN `mobilePhone` VARCHAR(191) NULL,
    ADD COLUMN `website` VARCHAR(191) NULL,
    ADD COLUMN `language` VARCHAR(191) NULL,
    ADD COLUMN `vatNumber` VARCHAR(191) NULL,
    ADD COLUMN `customerSource` VARCHAR(191) NULL,
    ADD COLUMN `problematicDepartments` TEXT NULL;
