CREATE TABLE IF NOT EXISTS `MaintenanceContract` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `period` ENUM('MONTHLY', 'QUARTERLY', 'BIANNUAL', 'YEARLY') NOT NULL,
  `startDate` DATETIME(3) NOT NULL,
  `endDate` DATETIME(3) NOT NULL,
  `equipmentInfo` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `MaintenanceContract_tenantId_idx` (`tenantId`),
  INDEX `MaintenanceContract_customerId_idx` (`customerId`),
  CONSTRAINT `MaintenanceContract_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `MaintenanceContract_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MaintenanceTask` (
  `id` VARCHAR(191) NOT NULL,
  `contractId` VARCHAR(191) NOT NULL,
  `assignedTechId` VARCHAR(191) NULL,
  `plannedDate` DATETIME(3) NOT NULL,
  `status` ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `MaintenanceTask_contractId_idx` (`contractId`),
  INDEX `MaintenanceTask_assignedTechId_idx` (`assignedTechId`),
  CONSTRAINT `MaintenanceTask_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `MaintenanceContract`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `MaintenanceTask_assignedTechId_fkey` FOREIGN KEY (`assignedTechId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MaintenanceReport` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `techId` VARCHAR(191) NOT NULL,
  `checklistJson` JSON NULL,
  `operationsDone` TEXT NOT NULL,
  `observations` TEXT NULL,
  `recommendations` TEXT NULL,
  `beforePhotoUrls` JSON NULL,
  `afterPhotoUrls` JSON NULL,
  `isSigned` BOOLEAN NOT NULL DEFAULT false,
  `customerSignature` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `MaintenanceReport_taskId_key` (`taskId`),
  INDEX `MaintenanceReport_techId_idx` (`techId`),
  CONSTRAINT `MaintenanceReport_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `MaintenanceTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `MaintenanceReport_techId_fkey` FOREIGN KEY (`techId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MaintenanceMaterial` (
  `id` VARCHAR(191) NOT NULL,
  `reportId` VARCHAR(191) NOT NULL,
  `articleId` VARCHAR(191) NOT NULL,
  `quantity` DOUBLE NOT NULL,
  `unitCost` DOUBLE NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `MaintenanceMaterial_reportId_idx` (`reportId`),
  INDEX `MaintenanceMaterial_articleId_idx` (`articleId`),
  CONSTRAINT `MaintenanceMaterial_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `MaintenanceReport`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `MaintenanceMaterial_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ServiceCall` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `assignedTechId` VARCHAR(191) NULL,
  `reportedIssue` TEXT NOT NULL,
  `status` ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  `callDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ServiceCall_tenantId_idx` (`tenantId`),
  INDEX `ServiceCall_customerId_idx` (`customerId`),
  INDEX `ServiceCall_assignedTechId_idx` (`assignedTechId`),
  CONSTRAINT `ServiceCall_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ServiceCall_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ServiceCall_assignedTechId_fkey` FOREIGN KEY (`assignedTechId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `WorkOrder` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `orderNumber` VARCHAR(191) NOT NULL,
  `orderType` VARCHAR(191) NOT NULL,
  `totalAmount` DOUBLE NOT NULL DEFAULT 0,
  `isBilled` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `WorkOrder_orderNumber_key` (`orderNumber`),
  INDEX `WorkOrder_tenantId_idx` (`tenantId`),
  INDEX `WorkOrder_customerId_idx` (`customerId`),
  CONSTRAINT `WorkOrder_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkOrder_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ServiceReport` (
  `id` VARCHAR(191) NOT NULL,
  `callId` VARCHAR(191) NOT NULL,
  `techId` VARCHAR(191) NOT NULL,
  `workDone` TEXT NOT NULL,
  `workingMinutes` INTEGER NOT NULL DEFAULT 0,
  `gasAmount` DOUBLE NOT NULL DEFAULT 0,
  `isWarranty` BOOLEAN NOT NULL DEFAULT false,
  `isSigned` BOOLEAN NOT NULL DEFAULT false,
  `customerSignature` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `linkedOrderId` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ServiceReport_callId_key` (`callId`),
  UNIQUE INDEX `ServiceReport_linkedOrderId_key` (`linkedOrderId`),
  INDEX `ServiceReport_techId_idx` (`techId`),
  CONSTRAINT `ServiceReport_callId_fkey` FOREIGN KEY (`callId`) REFERENCES `ServiceCall`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ServiceReport_techId_fkey` FOREIGN KEY (`techId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ServiceReport_linkedOrderId_fkey` FOREIGN KEY (`linkedOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ServiceMaterial` (
  `id` VARCHAR(191) NOT NULL,
  `reportId` VARCHAR(191) NOT NULL,
  `articleId` VARCHAR(191) NOT NULL,
  `quantity` DOUBLE NOT NULL,
  `unitCost` DOUBLE NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `ServiceMaterial_reportId_idx` (`reportId`),
  INDEX `ServiceMaterial_articleId_idx` (`articleId`),
  CONSTRAINT `ServiceMaterial_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `ServiceReport`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ServiceMaterial_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
