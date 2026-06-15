CREATE TABLE `ProjectAppointmentAssignment` (
  `id` VARCHAR(191) NOT NULL,
  `appointmentId` VARCHAR(191) NOT NULL,
  `technicianId` VARCHAR(191) NOT NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `ProjectAppointmentAssignment_appointmentId_technicianId_key` (`appointmentId`, `technicianId`),
  INDEX `ProjectAppointmentAssignment_appointmentId_idx` (`appointmentId`),
  INDEX `ProjectAppointmentAssignment_technicianId_idx` (`technicianId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProjectAppointmentAssignment`
  ADD CONSTRAINT `ProjectAppointmentAssignment_appointmentId_fkey`
  FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProjectAppointmentAssignment`
  ADD CONSTRAINT `ProjectAppointmentAssignment_technicianId_fkey`
  FOREIGN KEY (`technicianId`) REFERENCES `Employee`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO `ProjectAppointmentAssignment` (`id`, `appointmentId`, `technicianId`, `assignedAt`)
SELECT CONCAT('paa_', LEFT(UUID(), 18)), `id`, `assignedTechId`, NOW(3)
FROM `Appointment`
WHERE `assignedTechId` IS NOT NULL;
