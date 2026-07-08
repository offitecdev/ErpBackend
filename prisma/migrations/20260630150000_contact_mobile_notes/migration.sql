-- Add a mobile phone and a free-text notes field to each customer contact person.
ALTER TABLE `CustomerContact`
    ADD COLUMN `mobilePhone` VARCHAR(191) NULL,
    ADD COLUMN `notes` TEXT NULL;
