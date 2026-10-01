-- GÖREVLENDİRME: DER VERLAUF EINER STUFE (30.09.2026)
--
-- «Activities will show the history of the stage. Who did what … I should
--  click and see the details.»
--
-- Nur HINZUGEFÜGT: eine neue Tabelle, nichts umbenannt, nichts gelöscht — ein
-- älterer Stand des Servers läuft gegen diese Datenbank unverändert weiter.
-- Kein Fremdschlüssel nach aussen (Gerät, Aufgabe und Personen stehen als
-- blosse Kennung daneben), wie die übrigen `uretim_*`-Tabellen:
--   uretim_cihaz_gorev_aktiviteleri   je Handlung an den Aufgaben eines Geräts eine Zeile
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_cihaz_gorev_aktiviteleri` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productionItemId` VARCHAR(191) NOT NULL,
    `area` VARCHAR(16) NULL,
    `stage` VARCHAR(24) NULL,
    `taskId` VARCHAR(191) NULL,
    `taskCode` VARCHAR(16) NULL,
    `taskName` VARCHAR(200) NULL,
    `subtaskId` VARCHAR(40) NULL,
    `subtaskCode` VARCHAR(24) NULL,
    `subtaskName` VARCHAR(200) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `actorName` VARCHAR(160) NULL,
    `details` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `uretim_cihaz_gorev_aktiviteleri_stage_idx`(`tenantId`, `productionItemId`, `area`, `stage`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
