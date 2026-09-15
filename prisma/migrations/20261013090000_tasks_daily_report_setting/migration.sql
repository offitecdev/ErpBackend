-- Görevler: Gün sonu raporu saati (15.09.2026, Samet): 16:00 sabit değil,
-- Modül ayarları → Görevler'den firma bazında değiştirilebilir.
-- `promptTime` = «HH:MM» (tarayıcı saati); satır yoksa 16:00.
CREATE TABLE `TaskDailyReportSetting` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `promptTime` VARCHAR(5) NOT NULL DEFAULT '16:00',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TaskDailyReportSetting_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
