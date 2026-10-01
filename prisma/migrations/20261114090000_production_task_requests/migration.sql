-- GÖREVLENDİRME: ANFRAGEN AN DIE VERWALTUNG (30.09.2026)
--
-- «The normal employees should be able to send unlock requests to the admins
--  … requests should show the approvement requests and unlock requests …
--  add a button to mark the requests as solved.»
--
-- Nur HINZUGEFÜGT: eine neue Tabelle, nichts umbenannt, nichts gelöscht — ein
-- älterer Stand des Servers läuft gegen diese Datenbank unverändert weiter.
-- Kein Fremdschlüssel nach aussen, wie die übrigen `uretim_*`-Tabellen:
--   uretim_cihaz_gorev_talepleri   Freigabe- und Entsperr-Anfragen je Unteraufgabe
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_cihaz_gorev_talepleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(16) NOT NULL,
    `stage` VARCHAR(24) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `taskCode` VARCHAR(16) NOT NULL,
    `taskName` VARCHAR(200) NOT NULL,
    `subtaskId` VARCHAR(40) NOT NULL,
    `subtaskCode` VARCHAR(24) NOT NULL,
    `subtaskName` VARCHAR(200) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `note` VARCHAR(500) NULL,
    `requestedById` VARCHAR(191) NULL,
    `requestedByName` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `solvedAt` DATETIME(3) NULL,
    `solvedById` VARCHAR(191) NULL,
    `solvedByName` VARCHAR(160) NULL,
    `resolution` VARCHAR(16) NULL,

    INDEX `uretim_cihaz_gorev_talepleri_stage_idx`(`tenantId`, `productionItemId`, `area`, `stage`, `createdAt`),
    INDEX `uretim_cihaz_gorev_talepleri_subtask_idx`(`tenantId`, `productionItemId`, `subtaskId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
