-- Görevler: Gün sonu raporu (14.09.2026, Samet): hafta içi her gün 16:00'da
-- açılan pencereden kişi madde madde ne yaptığını yazar. Görev süreleri
-- kaydedildiği anın sayaç kayıtlarından kopyalanır (`taskTimes`, JSON) —
-- haftalık rapor bu günlük kayıtların toplamıdır.
-- `reportDate` = tarayıcının takvim günü (YYYY-MM-DD); sunucu saat dilimini bilmez.
CREATE TABLE `TaskDailyReport` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `reportDate` VARCHAR(10) NOT NULL,
    `items` TEXT NOT NULL,
    `taskTimes` TEXT NOT NULL,
    `totalMs` BIGINT NOT NULL DEFAULT 0,
    `submittedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TaskDailyReport_tenantId_employeeId_reportDate_key`(`tenantId`, `employeeId`, `reportDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
