CREATE TABLE IF NOT EXISTS `SignatureRequest` (
  `id` VARCHAR(191) NOT NULL,
  `tenantId` VARCHAR(191) NOT NULL,
  `reportType` VARCHAR(191) NOT NULL,
  `reportId` VARCHAR(191) NULL,
  `projectId` VARCHAR(191) NULL,
  `token` VARCHAR(128) NOT NULL,
  `customerEmail` VARCHAR(191) NULL,
  `title` VARCHAR(191) NULL,
  `snapshot` JSON NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `signatureBase64` LONGTEXT NULL,
  `signedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `SignatureRequest_token_key`(`token`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `SignatureRequest_tenantId_idx` ON `SignatureRequest`(`tenantId`);
CREATE INDEX `SignatureRequest_reportType_idx` ON `SignatureRequest`(`reportType`);
CREATE INDEX `SignatureRequest_reportId_idx` ON `SignatureRequest`(`reportId`);

ALTER TABLE `SignatureRequest`
  ADD CONSTRAINT `SignatureRequest_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
