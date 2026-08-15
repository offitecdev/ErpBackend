-- CRM-Umbau (Benutzerwunsch 2026-08-14): Ansprechpartner werden mandantenweit
-- listbar, Kommunikationshistorie (Telefon/E-Mail/Meeting/Notiz) und
-- Aufgaben/Erinnerungen bekommen eigene, schlanke Tabellen.
--
-- Apply with: npx prisma migrate deploy

-- CustomerContact: tenantId denormalisiert vom Kunden, damit die
-- mandantenweite Liste direkt aus dem Index blättert statt pro Anfrage
-- Customer zu joinen. Backfill, danach NOT NULL.
ALTER TABLE `CustomerContact` ADD COLUMN `tenantId` VARCHAR(191) NULL;
UPDATE `CustomerContact` cc
  JOIN `Customer` c ON c.`id` = cc.`customerId`
   SET cc.`tenantId` = c.`tenantId`;
ALTER TABLE `CustomerContact` MODIFY `tenantId` VARCHAR(191) NOT NULL;
CREATE INDEX `CustomerContact_tenantId_lastName_firstName_idx`
    ON `CustomerContact`(`tenantId`, `lastName`, `firstName`);

-- Kommunikationshistorie: eine Zeile pro Kundenkontakt (Telefon/E-Mail/
-- Meeting/Notiz). Bewusst flach — Kalender bleibt bei MeetingActivity.
CREATE TABLE `CrmCommunication` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `contactId` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NOT NULL,
    `note` TEXT NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdByEmployeeId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CrmCommunication_tenantId_occurredAt_idx`(`tenantId`, `occurredAt`),
    INDEX `CrmCommunication_customerId_occurredAt_idx`(`customerId`, `occurredAt`),
    INDEX `CrmCommunication_contactId_idx`(`contactId`),
    INDEX `CrmCommunication_createdByEmployeeId_idx`(`createdByEmployeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmCommunication` ADD CONSTRAINT `CrmCommunication_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CrmCommunication` ADD CONSTRAINT `CrmCommunication_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `CustomerContact`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `CrmCommunication` ADD CONSTRAINT `CrmCommunication_createdByEmployeeId_fkey` FOREIGN KEY (`createdByEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Aufgaben & Erinnerungen (kind TASK | REMINDER, status OPEN | DONE).
CREATE TABLE `CrmTask` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'TASK',
    `title` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `assigneeEmployeeId` VARCHAR(191) NULL,
    `dueDate` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `completedAt` DATETIME(3) NULL,
    `createdByEmployeeId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CrmTask_tenantId_status_dueDate_idx`(`tenantId`, `status`, `dueDate`),
    INDEX `CrmTask_customerId_idx`(`customerId`),
    INDEX `CrmTask_assigneeEmployeeId_idx`(`assigneeEmployeeId`),
    INDEX `CrmTask_createdByEmployeeId_idx`(`createdByEmployeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrmTask` ADD CONSTRAINT `CrmTask_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `CrmTask` ADD CONSTRAINT `CrmTask_assigneeEmployeeId_fkey` FOREIGN KEY (`assigneeEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `CrmTask` ADD CONSTRAINT `CrmTask_createdByEmployeeId_fkey` FOREIGN KEY (`createdByEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
