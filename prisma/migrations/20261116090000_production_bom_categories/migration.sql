-- ÜRETİM › BOM KATEGORİLERİ (02.10.2026)
--
-- «add category button to create categories like Mechanical and Electric …
--  for mechanical MEK-00001, for electric ELK-00001 — add them automatically;
--  for other categories we will define them.»
--
-- Nur HINZUGEFÜGT: eine neue Tabelle, nichts umbenannt, nichts gelöscht, keine
-- bestehende Zeile geändert — ein älterer Stand des Servers läuft gegen diese
-- Datenbank unverändert weiter. Mekanik und Elektrik bleiben FEST (keine
-- Zeile hier, ihre Alt-BOM-Kodes bleiben in `uretim_bom_ayarlari.codes`).
-- Kein Fremdschlüssel nach aussen, wie die übrigen `uretim_*`-Tabellen:
--   uretim_bom_kategorileri   eigene BOM-Kategorien (Name, Kod, Alt-BOM-Kodes)
--
-- Apply with: npx prisma migrate deploy

-- CreateTable
CREATE TABLE `uretim_bom_kategorileri` (
    `id` VARCHAR(16) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `code` VARCHAR(8) NOT NULL,
    `codes` JSON NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_bom_kategorileri_tenantId_code_key`(`tenantId`, `code`),
    INDEX `uretim_bom_kategorileri_tenantId_sortOrder_idx`(`tenantId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
