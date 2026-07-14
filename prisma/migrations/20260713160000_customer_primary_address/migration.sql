-- Split the customer's primary address into separate fields entered on the
-- customer profile. `address` keeps holding the street line; the new columns
-- carry the address name (label), postal code, city and country.
ALTER TABLE `Customer`
    ADD COLUMN `addressName` VARCHAR(191) NULL,
    ADD COLUMN `postalCode` VARCHAR(191) NULL,
    ADD COLUMN `city` VARCHAR(191) NULL,
    ADD COLUMN `country` VARCHAR(191) NULL;
