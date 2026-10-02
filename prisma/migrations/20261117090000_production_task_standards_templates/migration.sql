-- GÖREVLENDİRME › VORLAGEN DER DOKUMENT-STANDARDS (02.10.2026)
--
-- «In the Document standards the admin should be able to add a template for
--  standard and select a standard with a combobox.»
--
-- Nur HINZUGEFÜGT: eine neue Tabelle, nichts umbenannt, nichts gelöscht, keine
-- bestehende Zeile geändert — ein älterer Stand des Servers läuft gegen diese
-- Datenbank unverändert weiter. Kein Fremdschlüssel nach aussen:
--   uretim_gorev_standart_sablonlari   Name, Text und PDF-Verweis je Vorlage
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_gorev_standart_sablonlari` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `text` TEXT NULL,
    `file` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_gorev_standart_sablonlari_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
