-- CC e-mail lists for calendar entities: appointments and meeting activities.
ALTER TABLE `Appointment` ADD COLUMN `ccEmails` JSON NULL;
ALTER TABLE `MeetingActivity` ADD COLUMN `ccEmails` JSON NULL;
