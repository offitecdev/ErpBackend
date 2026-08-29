-- ANFRAGEN (10.09.2026, Vorgabe Samet)
--   1. Enquiry     — der Kontakt VOR dem Kunden. Trägt eigene Kontaktdaten,
--                    weil die anfragende Person meistens noch nicht im System
--                    steht; `customerId` entsteht erst beim Zuordnen/Umwandeln.
--                    Herkunft: FORM (öffentliches Formular), MAIL (im Postfach
--                    der Kategorie «Anfragen» zugeordnet) oder MANUAL.
--   2. EnquiryForm — das öffentliche Formular je Mandant: Token für den Link
--                    `/anfrage/<token>`, Texte, Feldregeln, Meldeadressen.

CREATE TABLE `Enquiry` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `source` VARCHAR(8) NOT NULL DEFAULT 'MANUAL',
    `status` VARCHAR(12) NOT NULL DEFAULT 'NEW',
    `priority` VARCHAR(8) NOT NULL DEFAULT 'NORMAL',
    `companyName` VARCHAR(200) NULL,
    `contactName` VARCHAR(160) NULL,
    `email` VARCHAR(255) NULL,
    `phone` VARCHAR(64) NULL,
    `address` VARCHAR(255) NULL,
    `addressSupplement` VARCHAR(255) NULL,
    `postalCode` VARCHAR(32) NULL,
    `city` VARCHAR(120) NULL,
    `state` VARCHAR(120) NULL,
    `country` VARCHAR(120) NULL,
    `subject` VARCHAR(300) NOT NULL,
    `message` TEXT NULL,
    `extraFields` JSON NULL,
    `customerId` VARCHAR(191) NULL,
    `contactId` VARCHAR(191) NULL,
    `mailMessageId` VARCHAR(191) NULL,
    `tenderId` VARCHAR(191) NULL,
    `assignedEmployeeId` VARCHAR(191) NULL,
    `createdByEmployeeId` VARCHAR(191) NULL,
    `internalNote` TEXT NULL,
    `submittedIp` VARCHAR(64) NULL,
    `answeredAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Enquiry_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `Enquiry_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
    INDEX `Enquiry_tenantId_assignedEmployeeId_createdAt_idx`(`tenantId`, `assignedEmployeeId`, `createdAt`),
    INDEX `Enquiry_tenantId_email_idx`(`tenantId`, `email`),
    INDEX `Enquiry_customerId_idx`(`customerId`),
    INDEX `Enquiry_contactId_idx`(`contactId`),
    INDEX `Enquiry_tenderId_idx`(`tenderId`),
    -- Eine Mail wird nur EINMAL zur Anfrage.
    UNIQUE INDEX `Enquiry_tenantId_mailMessageId_key`(`tenantId`, `mailMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `EnquiryForm` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `title` VARCHAR(200) NULL,
    `intro` TEXT NULL,
    `thanks` TEXT NULL,
    `fieldRules` JSON NULL,
    `notifyEmails` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EnquiryForm_token_key`(`token`),
    UNIQUE INDEX `EnquiryForm_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `CustomerContact`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_mailMessageId_fkey` FOREIGN KEY (`mailMessageId`) REFERENCES `MailMessage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_assignedEmployeeId_fkey` FOREIGN KEY (`assignedEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_createdByEmployeeId_fkey` FOREIGN KEY (`createdByEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `EnquiryForm` ADD CONSTRAINT `EnquiryForm_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
