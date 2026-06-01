ALTER TABLE `Tenant` ADD COLUMN IF NOT EXISTS `isProjectModuleEnabled` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS `Project` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `tenderId` VARCHAR(191) NULL,
  `managerId` VARCHAR(191) NULL,
  `projectName` VARCHAR(191) NOT NULL,
  `status` ENUM('AWAITING_APPROVAL', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'AWAITING_APPROVAL',
  `plannedBudget` DOUBLE NOT NULL DEFAULT 0,
  `actualCost` DOUBLE NOT NULL DEFAULT 0,
  `startDate` DATETIME(3) NULL,
  `endDate` DATETIME(3) NULL,
  `bookingToken` VARCHAR(128) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Project_tenderId_key` (`tenderId`),
  UNIQUE INDEX `Project_bookingToken_key` (`bookingToken`),
  INDEX `Project_tenantId_idx` (`tenantId`),
  INDEX `Project_customerId_idx` (`customerId`),
  CONSTRAINT `Project_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `Project_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `Project_tenderId_fkey` FOREIGN KEY (`tenderId`) REFERENCES `Tender`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `Project_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `ProjectPhase` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `phaseName` VARCHAR(191) NOT NULL,
  `progressPercentage` DOUBLE NOT NULL DEFAULT 0,
  `isCompleted` BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (`id`),
  INDEX `ProjectPhase_projectId_idx` (`projectId`),
  CONSTRAINT `ProjectPhase_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `Material` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `serialId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `stockQuantity` DOUBLE NOT NULL DEFAULT 0,
  `unitCost` DOUBLE NOT NULL DEFAULT 0,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Material_serialId_key` (`serialId`),
  INDEX `Material_tenantId_idx` (`tenantId`),
  CONSTRAINT `Material_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `ProjectReport` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `employeeId` VARCHAR(191) NOT NULL,
  `reportDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reportType` VARCHAR(191) NOT NULL,
  `workedMinutes` INTEGER NOT NULL DEFAULT 0,
  `operationsDone` TEXT NOT NULL,
  `technicalNotes` TEXT NULL,
  `customerSignature` LONGTEXT NULL,
  `isSigned` BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (`id`),
  INDEX `ProjectReport_projectId_idx` (`projectId`),
  INDEX `ProjectReport_employeeId_idx` (`employeeId`),
  CONSTRAINT `ProjectReport_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ProjectReport_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `ReportMaterial` (
  `id` VARCHAR(191) NOT NULL,
  `reportId` VARCHAR(191) NOT NULL,
  `articleId` VARCHAR(191) NULL,
  `quantity` DOUBLE NOT NULL,
  `costAtTime` DOUBLE NOT NULL,
  `materialId` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  INDEX `ReportMaterial_reportId_idx` (`reportId`),
  INDEX `ReportMaterial_articleId_idx` (`articleId`),
  INDEX `ReportMaterial_materialId_idx` (`materialId`),
  CONSTRAINT `ReportMaterial_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `ProjectReport`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ReportMaterial_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `ReportMaterial_materialId_fkey` FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `ProjectExpense` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `expenseType` VARCHAR(191) NOT NULL,
  `amount` DOUBLE NOT NULL,
  `description` TEXT NULL,
  `expenseDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ProjectExpense_projectId_idx` (`projectId`),
  CONSTRAINT `ProjectExpense_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `Appointment` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `customerId` VARCHAR(191) NULL,
  `startTime` DATETIME(3) NOT NULL,
  `endTime` DATETIME(3) NOT NULL,
  `status` ENUM('AVAILABLE', 'BOOKED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'AVAILABLE',
  `notes` TEXT NULL,
  PRIMARY KEY (`id`),
  INDEX `Appointment_tenantId_idx` (`tenantId`),
  INDEX `Appointment_startTime_endTime_idx` (`startTime`, `endTime`),
  CONSTRAINT `Appointment_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `Appointment_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `Appointment_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `ProjectVariation` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `requestedById` VARCHAR(191) NOT NULL,
  `materialId` VARCHAR(191) NOT NULL,
  `quantity` DOUBLE NOT NULL,
  `description` TEXT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `costAtTime` DOUBLE NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolvedById` VARCHAR(191) NULL,
  `resolvedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `ProjectVariation_projectId_idx` (`projectId`),
  CONSTRAINT `ProjectVariation_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ProjectVariation_materialId_fkey` FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);

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
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `MailSetting_tenantId_key` (`tenantId`),
  INDEX `MailSetting_tenantId_idx` (`tenantId`),
  CONSTRAINT `MailSetting_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);
