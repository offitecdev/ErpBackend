-- PERSONALAKTE, FEIERTAGE UND URLAUBSANSPRUCH (26.08.2026, Vorgabe Samet).
--
-- Drei neue Tabellen, keine Aenderung an bestehenden Daten:
--
--   StaffDocument     Arbeitsvertrag (genau EINER je Person, kind='CONTRACT')
--                     und die uebrigen Unterlagen der Personalakte
--                     (kind='DOCUMENT'). Die Bytes liegen auf der Platte,
--                     die Zeile haelt nur den Verweis -- dieselbe Regel wie
--                     bei Angebots- und Terminunterlagen.
--
--   PublicHoliday     Die vom Haus GEWAEHLTEN Feiertage. Der Katalog der
--                     amtlichen tuerkischen Feiertage steht im Code
--                     (src/shared/publicHolidays.ts); hier steht nur, was
--                     uebernommen wurde. Ein Feiertag ist kein Arbeitstag:
--                     er zaehlt weder gegen das Sollpensum noch als Fehltag,
--                     und ein Urlaubsantrag verbraucht ihn nicht.
--
--   StaffLeavePolicy  Die Regel, nach der der Jahresurlaub entsteht:
--                     anteilig nach geleisteten Arbeitstagen. Ein Plan je
--                     Mandantenbaum -- wie StaffShiftPlan.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `StaffDocument` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'DOCUMENT',
    `title` VARCHAR(200) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `contentType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `fileRef` VARCHAR(512) NOT NULL,
    `uploadedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StaffDocument_employeeId_kind_idx`(`employeeId`, `kind`),
    INDEX `StaffDocument_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StaffDocument`
    ADD CONSTRAINT `StaffDocument_employeeId_fkey`
    FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `PublicHoliday` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `catalogKey` VARCHAR(64) NULL,
    `countryCode` VARCHAR(2) NOT NULL DEFAULT 'TR',
    `religious` BOOLEAN NOT NULL DEFAULT false,
    `halfDay` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PublicHoliday_tenantId_date_name_key`(`tenantId`, `date`, `name`),
    INDEX `PublicHoliday_tenantId_date_idx`(`tenantId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `StaffLeavePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `annualWorkdays` INTEGER NOT NULL DEFAULT 250,
    `annualLeaveDays` INTEGER NOT NULL DEFAULT 14,
    `accrueByWorkdays` BOOLEAN NOT NULL DEFAULT true,
    `carryOverDays` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StaffLeavePolicy_tenantId_key`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
