-- ── GÖREVLER / TASKS-MODUL (13.09.2026, Vorgabe Samet) ─────────────────────────
--
-- «ayrı bir görev modülü istiyorum … projemizle ya da görevlerimizle bir
-- bağlantısı olmayacak»: ein eigenständiges Aufgabenmodul nach dem Vorbild
-- Görevly — Aufgaben, Verantwortliche, Etiketten, Inhaltsblöcke mit
-- Checklisten, Kommentare, Dateien, Zeitmessung per Start/Pause, Chat-Räume,
-- Erinnerungen. Keine Fremdschlüssel auf Employee, Project, CrmTask.
--
-- Von Hand geschrieben (nie `migrate dev` — die Datenbank trägt alte
-- Abweichungen, die es zurücksetzen wollte): die CREATE-Anweisungen stammen
-- wortgleich aus `prisma migrate diff`, nur die Tabellen dieses Moduls.
--
-- Datenteil am Ende: das neue Modul `tasks` wird in den Firmenkategorien
-- freigeschaltet, die einer Firma zugeordnet sind, und in den Modulpaketen
-- der Administratorrolle — genau das, was ensureSystemAdminRole beim nächsten
-- Öffnen der Berechtigungen ohnehin schriebe.

-- CreateTable
CREATE TABLE `Task` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED',
    `priority` VARCHAR(8) NOT NULL DEFAULT 'MEDIUM',
    `origin` VARCHAR(16) NOT NULL DEFAULT 'MANAGER',
    `flagged` BOOLEAN NOT NULL DEFAULT false,
    `startAt` DATETIME(3) NULL,
    `dueAt` DATETIME(3) NULL,
    `reminderAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `blockReason` TEXT NULL,
    `approvalState` VARCHAR(16) NOT NULL DEFAULT 'NONE',
    `approvalRequestedById` VARCHAR(191) NULL,
    `approvalRequestedAt` DATETIME(3) NULL,
    `approvalNote` TEXT NULL,
    `approvalDecidedById` VARCHAR(191) NULL,
    `approvalDecidedAt` DATETIME(3) NULL,
    `approvalDecisionNote` TEXT NULL,
    `reviewState` VARCHAR(16) NOT NULL DEFAULT 'APPROVED',
    `reviewRequestedById` VARCHAR(191) NULL,
    `reviewRequestedAt` DATETIME(3) NULL,
    `reviewDecidedById` VARCHAR(191) NULL,
    `reviewDecidedAt` DATETIME(3) NULL,
    `reviewNote` TEXT NULL,
    `boardPosition` DOUBLE NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Task_tenantId_status_dueAt_idx`(`tenantId`, `status`, `dueAt`),
    INDEX `Task_tenantId_dueAt_idx`(`tenantId`, `dueAt`),
    INDEX `Task_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `Task_tenantId_status_boardPosition_idx`(`tenantId`, `status`, `boardPosition`),
    INDEX `Task_tenantId_createdById_idx`(`tenantId`, `createdById`),
    INDEX `Task_reminderAt_idx`(`reminderAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskAssignee` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskAssignee_tenantId_employeeId_idx`(`tenantId`, `employeeId`),
    UNIQUE INDEX `TaskAssignee_taskId_employeeId_key`(`taskId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskLabel` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `color` VARCHAR(12) NOT NULL DEFAULT 'gray',
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TaskLabel_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskLabelLink` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `labelId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskLabelLink_labelId_idx`(`labelId`),
    UNIQUE INDEX `TaskLabelLink_taskId_labelId_key`(`taskId`, `labelId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskContent` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `blocks` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TaskContent_taskId_key`(`taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskChecklist` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TaskChecklist_taskId_position_idx`(`taskId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskChecklistItem` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `checklistId` VARCHAR(191) NOT NULL,
    `text` VARCHAR(500) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `doneAt` DATETIME(3) NULL,
    `doneById` VARCHAR(191) NULL,
    `assigneeId` VARCHAR(191) NULL,
    `dueAt` DATETIME(3) NULL,
    `reminderAt` DATETIME(3) NULL,
    `flagged` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TaskChecklistItem_checklistId_position_idx`(`checklistId`, `position`),
    INDEX `TaskChecklistItem_taskId_done_idx`(`taskId`, `done`),
    INDEX `TaskChecklistItem_tenantId_doneById_doneAt_idx`(`tenantId`, `doneById`, `doneAt`),
    INDEX `TaskChecklistItem_reminderAt_idx`(`reminderAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskComment` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `text` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskComment_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskAttachment` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `taskId` VARCHAR(191) NULL,
    `commentId` VARCHAR(191) NULL,
    `roomId` VARCHAR(191) NULL,
    `messageId` VARCHAR(191) NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(160) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `fileRef` VARCHAR(512) NOT NULL,
    `uploadedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskAttachment_taskId_kind_createdAt_idx`(`taskId`, `kind`, `createdAt`),
    INDEX `TaskAttachment_commentId_idx`(`commentId`),
    INDEX `TaskAttachment_roomId_idx`(`roomId`),
    INDEX `TaskAttachment_messageId_idx`(`messageId`),
    INDEX `TaskAttachment_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskTimeSession` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `runningKey` VARCHAR(191) NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TaskTimeSession_runningKey_key`(`runningKey`),
    INDEX `TaskTimeSession_taskId_employeeId_idx`(`taskId`, `employeeId`),
    INDEX `TaskTimeSession_tenantId_employeeId_startedAt_idx`(`tenantId`, `employeeId`, `startedAt`),
    INDEX `TaskTimeSession_tenantId_startedAt_idx`(`tenantId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskActivity` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `type` VARCHAR(32) NOT NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskActivity_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskChatRoom` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `lastMessageAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TaskChatRoom_tenantId_lastMessageAt_idx`(`tenantId`, `lastMessageAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskChatMember` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `lastReadAt` DATETIME(3) NULL,
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskChatMember_tenantId_employeeId_idx`(`tenantId`, `employeeId`),
    UNIQUE INDEX `TaskChatMember_roomId_employeeId_key`(`roomId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskChatRoomTask` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `linkedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskChatRoomTask_taskId_idx`(`taskId`),
    UNIQUE INDEX `TaskChatRoomTask_roomId_taskId_key`(`roomId`, `taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskChatMessage` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(12) NOT NULL DEFAULT 'TEXT',
    `senderId` VARCHAR(191) NULL,
    `text` TEXT NOT NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskChatMessage_roomId_createdAt_idx`(`roomId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskNotifyDispatch` (
    `id` VARCHAR(64) NOT NULL,
    `tenantId` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `targetId` VARCHAR(64) NOT NULL,
    `recipientId` VARCHAR(64) NOT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `batch` VARCHAR(32) NOT NULL,
    `firedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskNotifyDispatch_batch_idx`(`batch`),
    INDEX `TaskNotifyDispatch_firedAt_idx`(`firedAt`),
    UNIQUE INDEX `TaskNotifyDispatch_kind_targetId_recipientId_dueAt_key`(`kind`, `targetId`, `recipientId`, `dueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskUserSetting` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `reminderLeadMinutes` INTEGER NOT NULL DEFAULT 30,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TaskUserSetting_employeeId_key`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- AddForeignKey
ALTER TABLE `TaskAssignee` ADD CONSTRAINT `TaskAssignee_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskLabelLink` ADD CONSTRAINT `TaskLabelLink_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskLabelLink` ADD CONSTRAINT `TaskLabelLink_labelId_fkey` FOREIGN KEY (`labelId`) REFERENCES `TaskLabel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskContent` ADD CONSTRAINT `TaskContent_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChecklist` ADD CONSTRAINT `TaskChecklist_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChecklistItem` ADD CONSTRAINT `TaskChecklistItem_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChecklistItem` ADD CONSTRAINT `TaskChecklistItem_checklistId_fkey` FOREIGN KEY (`checklistId`) REFERENCES `TaskChecklist`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskComment` ADD CONSTRAINT `TaskComment_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_commentId_fkey` FOREIGN KEY (`commentId`) REFERENCES `TaskComment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `TaskChatRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `TaskChatMessage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskTimeSession` ADD CONSTRAINT `TaskTimeSession_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskActivity` ADD CONSTRAINT `TaskActivity_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChatMember` ADD CONSTRAINT `TaskChatMember_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `TaskChatRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChatRoomTask` ADD CONSTRAINT `TaskChatRoomTask_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `TaskChatRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChatRoomTask` ADD CONSTRAINT `TaskChatRoomTask_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskChatMessage` ADD CONSTRAINT `TaskChatMessage_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `TaskChatRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Modul in den BENUTZTEN Firmenkategorien freischalten (ohne Kategorie ist
-- ohnehin alles frei). Eine Kategorie, die niemandem zugeordnet ist, bleibt
-- unberührt.
UPDATE `ModuleProfile`
   SET `moduleKeys` = JSON_ARRAY_APPEND(`moduleKeys`, '$', 'tasks')
 WHERE JSON_VALID(`moduleKeys`)
   AND JSON_TYPE(`moduleKeys`) = 'ARRAY'
   AND NOT JSON_CONTAINS(`moduleKeys`, '"tasks"')
   AND `id` IN (SELECT `moduleProfileId` FROM `Tenant` WHERE `moduleProfileId` IS NOT NULL);

-- Modulpaket der Administratorrolle: alle Katalogschlüssel (adminModuleKeys).
UPDATE `RoleModuleConfig` rmc
  JOIN `Role` r ON r.`id` = rmc.`roleId`
   SET rmc.`moduleKeys` = JSON_ARRAY_APPEND(rmc.`moduleKeys`, '$', 'tasks')
 WHERE r.`isSystemAdmin` = 1
   AND JSON_VALID(rmc.`moduleKeys`)
   AND JSON_TYPE(rmc.`moduleKeys`) = 'ARRAY'
   AND NOT JSON_CONTAINS(rmc.`moduleKeys`, '"tasks"');
