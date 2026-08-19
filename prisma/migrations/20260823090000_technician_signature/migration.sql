-- TECHNIKER-UNTERSCHRIFT AUF DEN RAPPORTEN (Vorgabe 19.08.2026).
--
-- Bisher trug jeder Rapport nur die KUNDENSIGNATUR. Der ausführende Techniker
-- soll aber ebenfalls unterschreiben — auf seinem Tablet (/montage) wie im
-- Rapport-Editor des Projektleiters —, und beide Unterschriften erscheinen
-- nebeneinander auf dem PDF (Montage-Rapport, Übergabe-Rapport, Gesamtrapport).
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `DeliveryReport`
    ADD COLUMN `technicianSignature` LONGTEXT NULL,
    ADD COLUMN `technicianSignedAt` DATETIME(3) NULL;

ALTER TABLE `ProjectReport`
    ADD COLUMN `technicianSignature` LONGTEXT NULL,
    ADD COLUMN `technicianSignedAt` DATETIME(3) NULL;
