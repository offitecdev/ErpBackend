-- Eigene Firmenadresse je Mandant (11.09.2026).
--
-- Bisher druckte jeder Mandant die EINE Adresse aus den PDF-Einstellungen
-- (Ceres Tower - Hohenrainstrasse 24, 4133 Pratteln) — auch die türkische
-- Gesellschaft. Die fünf Spalten tragen die Adresse eines Mandanten; NULL
-- heisst weiterhin: gemeinsame Adresse aus den PDF-Einstellungen.
--
-- Das Gegenstück auf der Druckseite ist `pdfSettingsStore`
-- (usePdfSettings/getPdfSettings): Absenderzeile und QR-Gläubiger nehmen die
-- Adresse des aktiven Mandanten, sobald dort eine steht.

ALTER TABLE `Tenant`
    ADD COLUMN `addressLine1` VARCHAR(255) NULL,
    ADD COLUMN `addressLine2` VARCHAR(64) NULL,
    ADD COLUMN `postalCode` VARCHAR(16) NULL,
    ADD COLUMN `city` VARCHAR(120) NULL,
    ADD COLUMN `country` VARCHAR(2) NULL;

-- Offitec Isıtma ve Soğutma A.Ş. (Mandant `sub-tenant`), gedruckt als
--   Maltepe Serbest Bölgesi, Sarmaşık Sok. No:2 A, 35674 Menemen/İzmir
UPDATE `Tenant`
SET `addressLine1` = 'Maltepe Serbest Bölgesi, Sarmaşık Sok.',
    `addressLine2` = 'No:2 A',
    `postalCode`   = '35674',
    `city`         = 'Menemen/İzmir',
    `country`      = 'TR'
WHERE `id` = 'sub-tenant';
