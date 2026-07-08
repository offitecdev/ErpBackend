-- Replace the free-text "problematic departments" field with a
-- responsible employee captured as first + last name.
ALTER TABLE `Customer`
    DROP COLUMN `problematicDepartments`,
    ADD COLUMN `responsibleFirstName` VARCHAR(191) NULL,
    ADD COLUMN `responsibleLastName` VARCHAR(191) NULL;
