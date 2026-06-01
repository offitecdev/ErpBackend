CREATE TABLE IF NOT EXISTS `MailSetting` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `fromName` VARCHAR(191) NULL,
  `fromEmail` VARCHAR(191) NULL,
  `replyTo` VARCHAR(191) NULL,
  `smtpHost` VARCHAR(191) NULL,
  `smtpPort` INTEGER NOT NULL DEFAULT 587,
  `smtpSecure` BOOLEAN NOT NULL DEFAULT false,
  `smtpUser` VARCHAR(191) NULL,
  `smtpPassword` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `MailSetting_tenantId_key` (`tenantId`),
  INDEX `MailSetting_tenantId_idx` (`tenantId`),
  CONSTRAINT `MailSetting_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);
