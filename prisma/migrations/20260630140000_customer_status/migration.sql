-- Track a richer customer lifecycle status alongside the legacy isActive flag.
-- Values: ACTIVE, POTENTIAL (interested prospect), PASSIVE, BLOCKED, PROBLEMATIC.
ALTER TABLE `Customer`
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE';

-- Backfill existing rows from the previous active/passive boolean.
UPDATE `Customer` SET `status` = CASE WHEN `isActive` = 1 THEN 'ACTIVE' ELSE 'PASSIVE' END;
