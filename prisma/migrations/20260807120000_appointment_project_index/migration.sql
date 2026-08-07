-- Project detail filters appointments by projectId on every overview load.
-- Without this index, a growing Appointment table requires a full scan.
--
-- Apply with: npx prisma migrate deploy

CREATE INDEX `Appointment_projectId_idx` ON `Appointment`(`projectId`);
