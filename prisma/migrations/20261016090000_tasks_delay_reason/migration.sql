-- Görevler: Gecikme açıklaması (15.09.2026, Samet) — eine überfällige Aufgabe kann nur mit
-- kurzer Erklärung des Verzugs als fertig gemeldet werden; der Administrator sieht sie.
ALTER TABLE `Task`
    ADD COLUMN `delayReason` TEXT NULL,
    ADD COLUMN `delayReasonById` VARCHAR(191) NULL,
    ADD COLUMN `delayReasonAt` DATETIME(3) NULL;
