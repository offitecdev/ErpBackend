-- Cover the technician-specific montage filters instead of combining two
-- single-column indexes after the fact.
CREATE INDEX `Appointment_tenantId_assignedTechId_status_startTime_idx`
    ON `Appointment`(`tenantId`, `assignedTechId`, `status`, `startTime`);

CREATE INDEX `ProjectAppointmentAssignment_technicianId_appointmentId_idx`
    ON `ProjectAppointmentAssignment`(`technicianId`, `appointmentId`);

CREATE INDEX `ProjectReport_employeeId_salesOrderId_reportDate_idx`
    ON `ProjectReport`(`employeeId`, `salesOrderId`, `reportDate`);

CREATE INDEX `SignatureRequest_tenantId_reportType_reportId_idx`
    ON `SignatureRequest`(`tenantId`, `reportType`, `reportId`);
