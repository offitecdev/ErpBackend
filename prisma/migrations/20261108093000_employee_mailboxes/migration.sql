-- PERSÖNLICHES POSTFACH JE PERSON (28.09.2026) — siehe EmployeeMailbox in mail.prisma.

CREATE TABLE `EmployeeMailbox` (
    `id` VARCHAR(32) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `fromName` VARCHAR(255) NULL,
    `fromEmail` VARCHAR(255) NOT NULL,
    `smtpHost` VARCHAR(255) NULL,
    `smtpPort` INTEGER NOT NULL DEFAULT 465,
    `smtpSecure` BOOLEAN NOT NULL DEFAULT true,
    `smtpUser` VARCHAR(255) NULL,
    `smtpPassword` TEXT NULL,
    `imapHost` VARCHAR(255) NULL,
    `imapPort` INTEGER NOT NULL DEFAULT 993,
    `imapSecure` BOOLEAN NOT NULL DEFAULT true,
    `imapUser` VARCHAR(255) NULL,
    `imapPassword` TEXT NULL,
    `sentFolder` VARCHAR(255) NULL,
    `saveToSent` BOOLEAN NOT NULL DEFAULT true,
    `imapInboxFolder` VARCHAR(255) NULL,
    `imapCaptureEnabled` BOOLEAN NOT NULL DEFAULT true,
    `imapWindowMonths` INTEGER NOT NULL DEFAULT 2,
    `imapUidValidity` BIGINT NULL,
    `imapLastUid` BIGINT NULL,
    `imapSentUidValidity` BIGINT NULL,
    `imapSentLastUid` BIGINT NULL,
    `imapLastSyncAt` DATETIME(3) NULL,
    `imapLastError` TEXT NULL,
    `imapLastSummary` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EmployeeMailbox_employeeId_key`(`employeeId`),
    INDEX `EmployeeMailbox_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Jede Nachricht gehört einem Postfach: "" = Firmenpostfach (alle bisherigen
-- Zeilen), sonst die Id des persönlichen.
ALTER TABLE `MailMessage` ADD COLUMN `mailboxKey` VARCHAR(32) NOT NULL DEFAULT '';

-- Die Eindeutigkeit gilt JE POSTFACH: dieselbe Nachricht darf im Firmenpostfach
-- UND im Postfach einer Person liegen (z. B. eine Mail an beide), und zwei
-- Konten auf demselben Server haben gleiche Ordner-/UID-Kennungen.
DROP INDEX `MailMessage_tenantId_providerMessageId_key` ON `MailMessage`;
DROP INDEX `MailMessage_tenantId_internetMessageId_direction_key` ON `MailMessage`;
CREATE UNIQUE INDEX `MailMessage_tenantId_mailboxKey_providerMessageId_key`
    ON `MailMessage`(`tenantId`, `mailboxKey`, `providerMessageId`);
CREATE UNIQUE INDEX `MailMessage_tenantId_mailboxKey_internetMessageId_direction_key`
    ON `MailMessage`(`tenantId`, `mailboxKey`, `internetMessageId`, `direction`);
CREATE INDEX `MailMessage_tenantId_mailboxKey_sentAt_idx`
    ON `MailMessage`(`tenantId`, `mailboxKey`, `sentAt`);
