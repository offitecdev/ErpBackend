-- WER DEN TERMIN ANGELEGT HAT (19.08.2026).
-- Die automatische Teammail (Techniker + CC-Liste + Ersteller:in) braucht die
-- Person, die den Termin gesetzt hat. Bestehende Termine bleiben NULL — dort
-- faellt die Teammail einfach auf Team + CC zurueck.
ALTER TABLE `Appointment` ADD COLUMN `createdByEmployeeId` VARCHAR(191) NULL;

CREATE INDEX `Appointment_createdByEmployeeId_idx` ON `Appointment`(`createdByEmployeeId`);

ALTER TABLE `Appointment`
  ADD CONSTRAINT `Appointment_createdByEmployeeId_fkey`
  FOREIGN KEY (`createdByEmployeeId`) REFERENCES `Employee`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
