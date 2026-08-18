-- OUTLOOK / MICROSOFT-365-ANBINDUNG, Phase 1 (17.08.2026).
--
-- Vorgabe: das ERP soll mit Outlook / Microsoft 365 verbunden werden, OHNE
-- anfangs Speicher zu fressen — keine Mail-Dateien, keine Anhänge, nur die
-- Grunddaten (Absender, Empfänger, Betreff, Zeitpunkt, Text) plus die
-- Zuordnung zum Kunden. Anhänge nur als Metadaten/Link; wichtige PDFs lädt
-- der Benutzer selbst in "Dokumente" hoch.
--
--   MailSetting  += App-Registrierung (Client-Id/-Secret/Azure-Mandant) und das
--                   Fenster der Erstsynchronisation in Tagen.
--   MailAccount   = verbundenes Postfach je Mitarbeitende:r (OAuth-Tokens
--                   verschlüsselt, Delta-Links als Sync-Stand).
--   MailMessage   = eine Nachricht (Outlook-Sync oder ERP-Sendung) mit
--                   Kundenzuordnung. `activityId` zeigt auf die CustomerActivity
--                   derselben Sendung (OFFER_MAIL_SENT/ORDER_MAIL_SENT), damit
--                   die Interaktionsliste sie nicht doppelt zeigt.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `MailSetting`
    ADD COLUMN `msClientId` VARCHAR(128) NULL,
    ADD COLUMN `msClientSecret` TEXT NULL,
    ADD COLUMN `msTenantId` VARCHAR(128) NULL,
    ADD COLUMN `msSyncDays` INTEGER NOT NULL DEFAULT 30;

CREATE TABLE `MailAccount` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(16) NOT NULL DEFAULT 'MICROSOFT',
    `mailboxAddress` VARCHAR(255) NOT NULL,
    `displayName` VARCHAR(255) NULL,
    `externalUserId` VARCHAR(128) NULL,
    `refreshToken` TEXT NOT NULL,
    `accessToken` TEXT NULL,
    `accessTokenExpiresAt` DATETIME(3) NULL,
    `scopes` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `lastError` TEXT NULL,
    `syncEnabled` BOOLEAN NOT NULL DEFAULT true,
    `syncFromDate` DATETIME(3) NULL,
    `inboxDeltaLink` TEXT NULL,
    `sentDeltaLink` TEXT NULL,
    `lastSyncAt` DATETIME(3) NULL,
    `lastSyncStartedAt` DATETIME(3) NULL,
    `lastSyncSummary` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MailAccount_tenantId_employeeId_provider_key`(`tenantId`, `employeeId`, `provider`),
    INDEX `MailAccount_tenantId_status_idx`(`tenantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MailMessage` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NULL,
    `employeeId` VARCHAR(191) NULL,
    `direction` VARCHAR(4) NOT NULL,
    `origin` VARCHAR(8) NOT NULL,
    `providerMessageId` VARCHAR(255) NULL,
    `internetMessageId` VARCHAR(255) NULL,
    `conversationId` VARCHAR(255) NULL,
    `subject` VARCHAR(500) NULL,
    `fromName` VARCHAR(255) NULL,
    `fromAddress` VARCHAR(255) NULL,
    `toRecipients` JSON NOT NULL,
    `ccRecipients` JSON NULL,
    `bodyPreview` VARCHAR(512) NULL,
    `bodyText` TEXT NULL,
    `sentAt` DATETIME(3) NOT NULL,
    `hasAttachments` BOOLEAN NOT NULL DEFAULT false,
    `attachments` JSON NULL,
    `webLink` TEXT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT true,
    `customerId` VARCHAR(191) NULL,
    `contactId` VARCHAR(191) NULL,
    `matchSource` VARCHAR(16) NULL,
    `entityType` VARCHAR(24) NULL,
    `entityId` VARCHAR(191) NULL,
    `entityLabel` VARCHAR(64) NULL,
    `activityId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MailMessage_accountId_providerMessageId_key`(`accountId`, `providerMessageId`),
    INDEX `MailMessage_tenantId_sentAt_idx`(`tenantId`, `sentAt`),
    INDEX `MailMessage_tenantId_customerId_sentAt_idx`(`tenantId`, `customerId`, `sentAt`),
    INDEX `MailMessage_tenantId_direction_sentAt_idx`(`tenantId`, `direction`, `sentAt`),
    INDEX `MailMessage_tenantId_internetMessageId_idx`(`tenantId`, `internetMessageId`),
    INDEX `MailMessage_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `MailMessage_activityId_idx`(`activityId`),
    INDEX `MailMessage_contactId_idx`(`contactId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MailAccount`
    ADD CONSTRAINT `MailAccount_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MailMessage`
    ADD CONSTRAINT `MailMessage_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `MailAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `MailMessage_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `MailMessage_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `CustomerContact`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
