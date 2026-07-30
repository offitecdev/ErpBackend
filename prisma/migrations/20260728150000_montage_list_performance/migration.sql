-- Lightweight montage tables filter by tenant/technician/status and sort by
-- date. These indexes keep the 10-row paged queries away from full scans.
CREATE INDEX `Appointment_tenantId_status_startTime_idx`
    ON `Appointment`(`tenantId`, `status`, `startTime`);

CREATE INDEX `ProjectReport_employeeId_reportDate_idx`
    ON `ProjectReport`(`employeeId`, `reportDate`);

CREATE INDEX `DeliveryReport_tenantId_employeeId_createdAt_idx`
    ON `DeliveryReport`(`tenantId`, `employeeId`, `createdAt`);
