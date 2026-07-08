-- Customer addresses are now split into two independent lists:
-- INSTALLATION (Montage/Lieferung) and BILLING (Rechnung).
ALTER TABLE `CustomerLocation`
    ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'INSTALLATION';

-- Quote/tender: remember when billing should mirror the installation address,
-- so it doesn't have to be entered twice.
ALTER TABLE `Tender`
    ADD COLUMN `billingSameAsInstallation` BOOLEAN NULL DEFAULT FALSE;
