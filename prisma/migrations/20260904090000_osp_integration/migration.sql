-- OSP-Integration (04.09.2026): Webhook-Eingang der Offitec Selection Platform,
-- Statusmeldung zurück, und der Offerten-Import mit manuell erfasstem Kunden.

-- Manuell erfasster Kunde auf der Offerte (OSP-Import): Name/Adresse/E-Mail
-- direkt am Beleg, ohne CRM-Kunden anzulegen.
ALTER TABLE `Tender`
    ADD COLUMN `manualCustomerName` VARCHAR(191) NULL,
    ADD COLUMN `manualCustomerEmail` VARCHAR(191) NULL,
    ADD COLUMN `manualCustomerAddress` TEXT NULL;

-- Einstellungen je Firmenbaum-Wurzel: Schlüssel + teilnehmende Mandanten.
CREATE TABLE `OspSetting` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `webhookKey` VARCHAR(191) NULL,
    `ospBaseUrl` VARCHAR(255) NULL,
    `ospApiKey` TEXT NULL,
    `tenantIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OspSetting_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Ein OSP-Dokument = eine Einheit mit eigenem Datenblatt und eigenem Status.
CREATE TABLE `OspDocument` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `projectNumber` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NULL,
    `projectName` VARCHAR(191) NOT NULL DEFAULT '',
    `requesterFirstName` VARCHAR(191) NULL,
    `requesterLastName` VARCHAR(191) NULL,
    `requesterEmail` VARCHAR(191) NULL,
    `country` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `postalCode` VARCHAR(191) NULL,
    `userType` VARCHAR(191) NULL,
    `category` VARCHAR(191) NULL,
    `unitType` VARCHAR(191) NULL,
    `model` VARCHAR(191) NULL,
    `ospCreatedAt` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'LISTED',
    `salespersonId` VARCHAR(191) NULL,
    `salespersonEmail` VARCHAR(191) NULL,
    `salespersonName` VARCHAR(191) NULL,
    `salespersonRole` VARCHAR(191) NOT NULL DEFAULT 'SALES',
    `tenderId` VARCHAR(191) NULL,
    `tenderNumber` VARCHAR(191) NULL,
    `lastReportedStatus` VARCHAR(191) NULL,
    `lastReportAt` DATETIME(3) NULL,
    `lastReportError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OspDocument_tenantId_reference_key`(`tenantId`, `reference`),
    INDEX `OspDocument_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
    INDEX `OspDocument_tenantId_projectNumber_idx`(`tenantId`, `projectNumber`),
    INDEX `OspDocument_tenderId_idx`(`tenderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
