-- Profilbild der Personenseite (17.08.2026).
--
-- Das Bild wird als Daten-URL gespeichert — dieselbe Bauart wie die Bilder der
-- Rapporte (DeliveryReport.images). In die vorgegebenen VARCHAR(191) passt
-- davon keine einzige Zeile, deshalb MEDIUMTEXT.

ALTER TABLE `Employee`
    MODIFY COLUMN `profilePictureUrl` MEDIUMTEXT NULL;
