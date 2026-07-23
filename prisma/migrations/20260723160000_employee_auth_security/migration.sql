-- Auth hardening: track when a password was last changed (JWT invalidation via
-- the `pwdAt` claim) and support soft deletion checked on every request.
ALTER TABLE `Employee`
    ADD COLUMN `passwordChangedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL;
