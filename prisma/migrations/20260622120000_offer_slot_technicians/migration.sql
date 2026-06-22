-- Add responsible technician to proposal (offer) schedule slots
ALTER TABLE `OfferScheduleSlot`
  ADD COLUMN `assignedTechId` VARCHAR(191) NULL;

CREATE INDEX `OfferScheduleSlot_assignedTechId_idx` ON `OfferScheduleSlot`(`assignedTechId`);

ALTER TABLE `OfferScheduleSlot`
  ADD CONSTRAINT `OfferScheduleSlot_assignedTechId_fkey`
  FOREIGN KEY (`assignedTechId`) REFERENCES `Employee`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Additional technicians assigned to a proposal schedule slot
CREATE TABLE `OfferScheduleSlotAssignment` (
  `id` VARCHAR(191) NOT NULL,
  `slotId` VARCHAR(191) NOT NULL,
  `technicianId` VARCHAR(191) NOT NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `OfferScheduleSlotAssignment_slotId_technicianId_key` (`slotId`, `technicianId`),
  INDEX `OfferScheduleSlotAssignment_slotId_idx` (`slotId`),
  INDEX `OfferScheduleSlotAssignment_technicianId_idx` (`technicianId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `OfferScheduleSlotAssignment`
  ADD CONSTRAINT `OfferScheduleSlotAssignment_slotId_fkey`
  FOREIGN KEY (`slotId`) REFERENCES `OfferScheduleSlot`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `OfferScheduleSlotAssignment`
  ADD CONSTRAINT `OfferScheduleSlotAssignment_technicianId_fkey`
  FOREIGN KEY (`technicianId`) REFERENCES `Employee`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
