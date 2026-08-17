-- Eine Checkliste für MEHRERE Kunden (Benutzerwunsch 16.08.2026).
--
-- Bisher legte das Verknüpfen je Paar (Kunde, Angebot) eine eigene Checkliste
-- an — fünf Kunden mit je vier Angeboten ergaben zwanzig Stück. Ab jetzt gibt
-- es EINE Checkliste, die an beliebig viele Kunden/Angebote gehängt wird; die
-- Verknüpfungen stehen in dieser Tabelle.
--
-- Die flachen Spalten auf FormSubmission bleiben und tragen die ERSTE
-- Verknüpfung (Beschriftungen, PDF-Kopf, Altbestand). Der Nachtrag unten legt
-- für jede bestehende Checkliste genau eine Verknüpfungszeile an, damit die
-- Kontext-Abfragen sofort über die neue Tabelle laufen können.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `FormSubmissionLink` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `submissionId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `tenderId` VARCHAR(191) NULL,
    `salesOrderId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FormSubmissionLink_submissionId_idx`(`submissionId`),
    INDEX `FormSubmissionLink_tenantId_customerId_idx`(`tenantId`, `customerId`),
    INDEX `FormSubmissionLink_tenderId_idx`(`tenderId`),
    INDEX `FormSubmissionLink_salesOrderId_idx`(`salesOrderId`),
    INDEX `FormSubmissionLink_projectId_idx`(`projectId`),
    INDEX `FormSubmissionLink_appointmentId_idx`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `FormSubmissionLink` ADD CONSTRAINT `FormSubmissionLink_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `FormSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `FormSubmissionLink` ADD CONSTRAINT `FormSubmissionLink_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Nachtrag: je bestehender Checkliste eine Verknüpfung aus ihren flachen
-- Spalten. Checklisten ganz ohne Verknüpfung bleiben aussen vor (sie hängen an
-- nichts und sollen auch nirgends auftauchen).
INSERT INTO `FormSubmissionLink` (`id`, `tenantId`, `submissionId`, `customerId`, `tenderId`, `salesOrderId`, `projectId`, `appointmentId`, `createdAt`)
SELECT CONCAT('lnk', LEFT(MD5(`s`.`id`), 7)), `s`.`tenantId`, `s`.`id`, `s`.`customerId`, `s`.`tenderId`, `s`.`salesOrderId`, `s`.`projectId`, `s`.`appointmentId`, `s`.`createdAt`
  FROM `FormSubmission` `s`
 WHERE `s`.`customerId` IS NOT NULL
    OR `s`.`tenderId` IS NOT NULL
    OR `s`.`salesOrderId` IS NOT NULL
    OR `s`.`projectId` IS NOT NULL
    OR `s`.`appointmentId` IS NOT NULL;
