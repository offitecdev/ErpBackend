CREATE TABLE IF NOT EXISTS `ProjectReportImage` (
  `id` VARCHAR(191) NOT NULL,
  `reportId` VARCHAR(191) NOT NULL,
  `imageData` LONGTEXT NOT NULL,
  `caption` VARCHAR(191) NULL,
  `uploadedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `ProjectReportImage_reportId_idx` ON `ProjectReportImage`(`reportId`);

ALTER TABLE `ProjectReportImage`
  ADD CONSTRAINT `ProjectReportImage_reportId_fkey`
  FOREIGN KEY (`reportId`) REFERENCES `ProjectReport`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
