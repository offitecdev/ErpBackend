-- Field-report saves resolve the report for one project/order/day and calculate
-- planned minutes from that order's appointments. Composite indexes keep both
-- reads scoped instead of scanning unrelated project rows.
--
-- Apply with: npx prisma migrate deploy

CREATE INDEX `ProjectReport_projectId_salesOrderId_workDate_idx`
    ON `ProjectReport`(`projectId`, `salesOrderId`, `workDate`);

CREATE INDEX `Appointment_projectId_salesOrderId_status_startTime_endTime_idx`
    ON `Appointment`(`projectId`, `salesOrderId`, `status`, `startTime`, `endTime`);
