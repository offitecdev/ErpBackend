-- Firmenname des anfragenden OSP-Benutzers fuer die Offertenuebernahme.
ALTER TABLE `OspDocument`
    ADD COLUMN `company` VARCHAR(191) NULL;
