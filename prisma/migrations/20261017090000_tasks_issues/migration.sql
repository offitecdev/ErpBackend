-- Görevler: «Sorular & Sorunlar» (16.09.2026, Samet) — ein Faden je Frage/Problem an einer
-- Aufgabe, mit markierten Personen (die Erste ins An-Feld, der Rest in Kopie), markierten
-- anderen Aufgaben und Antworten. Dateien hängen an der Nachricht (TaskAttachment.kind ISSUE).

CREATE TABLE `TaskIssue` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'OPEN',
    `important` BOOLEAN NOT NULL DEFAULT false,
    `authorId` VARCHAR(191) NOT NULL,
    `lastMessageAt` DATETIME(3) NOT NULL,
    `resolvedById` VARCHAR(191) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TaskIssue_tenantId_taskId_kind_lastMessageAt_idx`(`tenantId`, `taskId`, `kind`, `lastMessageAt`),
    INDEX `TaskIssue_tenantId_authorId_idx`(`tenantId`, `authorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaskIssueMessage` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `text` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskIssueMessage_issueId_createdAt_idx`(`issueId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaskIssuePerson` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(4) NOT NULL DEFAULT 'CC',
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TaskIssuePerson_issueId_employeeId_key`(`issueId`, `employeeId`),
    INDEX `TaskIssuePerson_tenantId_employeeId_idx`(`tenantId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaskIssueTaskLink` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TaskIssueTaskLink_issueId_taskId_key`(`issueId`, `taskId`),
    INDEX `TaskIssueTaskLink_taskId_idx`(`taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TaskAttachment` ADD COLUMN `issueMessageId` VARCHAR(191) NULL;
CREATE INDEX `TaskAttachment_issueMessageId_idx` ON `TaskAttachment`(`issueMessageId`);

ALTER TABLE `TaskIssue` ADD CONSTRAINT `TaskIssue_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskIssueMessage` ADD CONSTRAINT `TaskIssueMessage_issueId_fkey`
    FOREIGN KEY (`issueId`) REFERENCES `TaskIssue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskIssuePerson` ADD CONSTRAINT `TaskIssuePerson_issueId_fkey`
    FOREIGN KEY (`issueId`) REFERENCES `TaskIssue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskIssueTaskLink` ADD CONSTRAINT `TaskIssueTaskLink_issueId_fkey`
    FOREIGN KEY (`issueId`) REFERENCES `TaskIssue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskIssueTaskLink` ADD CONSTRAINT `TaskIssueTaskLink_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_issueMessageId_fkey`
    FOREIGN KEY (`issueMessageId`) REFERENCES `TaskIssueMessage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
