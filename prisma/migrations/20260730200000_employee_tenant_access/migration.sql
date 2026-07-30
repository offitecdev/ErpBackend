-- Per-employee company assignment: the tenants of the company tree this staff
-- member may work in and switch between (null = the whole tree, as before).
ALTER TABLE `Employee` ADD COLUMN `allowedTenantIds` JSON NULL;
