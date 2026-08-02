-- Tender activity timelines filter by referenceId and order by activityDate DESC.
-- A composite index serves both operations and removes the full table scan.
CREATE INDEX `CustomerActivity_referenceId_activityDate_idx`
ON `CustomerActivity`(`referenceId`, `activityDate`);
