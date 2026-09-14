-- Zeitmessung nach Zeitstempeln (14.09.2026, Samet): je Firma, Person und
-- Gegenstand EIN Stand — Zustand, Beginn des laufenden Abschnitts, gesammelte
-- Millisekunden. Die Dauer rechnet immer der Server; der Browser meldet nie
-- eine Zeitspanne, höchstens den Klickzeitpunkt (begrenzt, siehe Service).
CREATE TABLE `ServerTimer` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `subjectType` VARCHAR(40) NOT NULL,
    `subjectId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'IDLE',
    `startedAt` DATETIME(3) NULL,
    `accumulatedMs` BIGINT NOT NULL DEFAULT 0,
    `completedAt` DATETIME(3) NULL,
    `lastTransitionAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ServerTimer_tenantId_ownerId_subjectType_subjectId_key`(`tenantId`, `ownerId`, `subjectType`, `subjectId`),
    INDEX `ServerTimer_tenantId_ownerId_status_idx`(`tenantId`, `ownerId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
