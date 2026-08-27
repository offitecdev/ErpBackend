-- MEHRTÄGIGE EINSÄTZE, TAGESZEITEN UND TERMINUNTERLAGEN (24.08.2026).
--
-- Vorgabe: ein Termin soll über mehrere aufeinanderfolgende Tage laufen können
-- (drei, vier Tage am Stück), jeder Tag mit EIGENEN Arbeitszeiten; die Tage
-- gehören trotzdem zu EINEM Einsatz — eine Mail, ein Satz Unterlagen, ein
-- Begleitwort. Zusätzlich sollen an einem Termin Unterlagen hängen (Notiz,
-- Bilder, PDF), die NICHT an den Kunden gehen, sondern der Monteurin auf dem
-- Bildschirm zur Verfügung stehen.
--
-- WARUM EINE ZEILE JE TAG statt einer Zeile von Montag bis Donnerstag: an
-- jedem Tag hängen der Tagesrapport, die geplanten Minuten und daraus die
-- Überstundenrechnung (AddProjectReportUseCase liest die Termine EINES Tages).
-- Ein Balken über vier Tage hätte für alle vier eine einzige Zeitspanne und
-- damit weder Tageszeiten noch Tagesrapporte. `seriesId` ist deshalb nur das
-- Band um die Tage, nicht ihr Ersatz.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `AppointmentSeries` (
    `id`        VARCHAR(191) NOT NULL,
    `tenantId`  VARCHAR(191) NOT NULL,
    `coverNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AppointmentSeries_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AppointmentDocument` (
    `id`           VARCHAR(191) NOT NULL,
    `tenantId`     VARCHAR(191) NOT NULL,
    `seriesId`     VARCHAR(191) NOT NULL,
    `fileName`     VARCHAR(191) NOT NULL,
    `contentType`  VARCHAR(191) NOT NULL,
    `sizeBytes`    INTEGER NOT NULL,
    `data`         LONGTEXT NOT NULL,
    `uploadedById` VARCHAR(191) NULL,
    `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AppointmentDocument_seriesId_createdAt_idx`(`seriesId`, `createdAt`),
    INDEX `AppointmentDocument_tenantId_idx`(`tenantId`),
    INDEX `AppointmentDocument_uploadedById_idx`(`uploadedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Appointment`
    ADD COLUMN `seriesId` VARCHAR(191) NULL,
    ADD COLUMN `dayIndex` INTEGER NOT NULL DEFAULT 0;

CREATE INDEX `Appointment_seriesId_startTime_idx` ON `Appointment`(`seriesId`, `startTime`);

-- Die Serie überlebt das Löschen eines Tages nicht andersherum: fällt die Serie
-- weg, bleibt der Tag ein gewöhnlicher Einzeltermin (SET NULL). Die Unterlagen
-- dagegen gehören der Serie und gehen mit ihr (CASCADE).
ALTER TABLE `Appointment`
    ADD CONSTRAINT `Appointment_seriesId_fkey`
    FOREIGN KEY (`seriesId`) REFERENCES `AppointmentSeries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `AppointmentDocument`
    ADD CONSTRAINT `AppointmentDocument_seriesId_fkey`
    FOREIGN KEY (`seriesId`) REFERENCES `AppointmentSeries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AppointmentDocument`
    ADD CONSTRAINT `AppointmentDocument_uploadedById_fkey`
    FOREIGN KEY (`uploadedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
