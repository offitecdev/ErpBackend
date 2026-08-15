-- Checklisten / Formulare / Vorlagen (Benutzerwunsch 2026-08-15): branchen-
-- neutrale Vorlagen mit frei wählbaren Feldtypen und bedingten Feldern,
-- ausgefüllte Formulare am Kunden entlang der Kette Angebot → Auftrag →
-- Projekt → Termin → Technikerbildschirm, dazu Hinweise für den Einsatz vor
-- Ort (FieldNote).
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `FormTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `category` VARCHAR(191) NULL,
    `fields` JSON NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdByEmployeeId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FormTemplate_tenantId_isActive_name_idx`(`tenantId`, `isActive`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `FormSubmission` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NULL,
    `templateName` VARCHAR(191) NOT NULL,
    `templateFields` JSON NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `tenderId` VARCHAR(191) NULL,
    `salesOrderId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'DRAFT',
    `values` JSON NOT NULL,
    `notes` TEXT NULL,
    `filledByEmployeeId` VARCHAR(191) NULL,
    `filledByName` VARCHAR(191) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FormSubmission_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `FormSubmission_tenantId_customerId_createdAt_idx`(`tenantId`, `customerId`, `createdAt`),
    INDEX `FormSubmission_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `FormSubmission_templateId_idx`(`templateId`),
    INDEX `FormSubmission_tenderId_idx`(`tenderId`),
    INDEX `FormSubmission_salesOrderId_idx`(`salesOrderId`),
    INDEX `FormSubmission_projectId_idx`(`projectId`),
    INDEX `FormSubmission_appointmentId_idx`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `FieldNote` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NULL,
    `salesOrderId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `text` TEXT NOT NULL,
    `createdByEmployeeId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FieldNote_tenantId_projectId_createdAt_idx`(`tenantId`, `projectId`, `createdAt`),
    INDEX `FieldNote_tenantId_customerId_createdAt_idx`(`tenantId`, `customerId`, `createdAt`),
    INDEX `FieldNote_salesOrderId_idx`(`salesOrderId`),
    INDEX `FieldNote_appointmentId_idx`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `FormSubmission` ADD CONSTRAINT `FormSubmission_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `FormTemplate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `FormSubmission` ADD CONSTRAINT `FormSubmission_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `FieldNote` ADD CONSTRAINT `FieldNote_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
