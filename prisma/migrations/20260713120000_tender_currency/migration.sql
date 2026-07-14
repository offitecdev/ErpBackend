-- Offer currency (CHF/EUR/USD/GBP/TRY). Symbol-only display; existing offers
-- keep NULL and fall back to CHF in the UI.
ALTER TABLE `Tender`
    ADD COLUMN `currency` VARCHAR(191) NULL;
