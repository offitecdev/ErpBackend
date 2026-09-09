-- STORNO (06.09.2026) — Vorgabe Samet: geloescht wird nur, was Entwurf ist und
-- an nichts haengt; jeder offizielle Beleg wird STORNIERT und bleibt stehen.
-- Wer/wann/warum liegt neben dem Status, damit die Zeile ihre Geschichte
-- selbst erzaehlt.

-- Die Offerte bekommt einen eigenen Status: jeder Schreibpfad im
-- TenderController laesst nur `Draft` durch, also sperrt der Wert die
-- stornierte Offerte ohne eine einzige weitere Pruefung.
ALTER TABLE `Tender` MODIFY COLUMN `status` ENUM('Draft', 'Approved', 'Exported', 'Cancelled') NOT NULL DEFAULT 'Draft';
ALTER TABLE `Tender` ADD COLUMN `cancelledAt` DATETIME(3) NULL;
ALTER TABLE `Tender` ADD COLUMN `cancelledById` VARCHAR(191) NULL;
ALTER TABLE `Tender` ADD COLUMN `cancelReason` TEXT NULL;

-- Der Auftrag traegt seinen Status als Text ('ORDERED' | 'CANCELLED').
ALTER TABLE `SalesOrder` ADD COLUMN `cancelledAt` DATETIME(3) NULL;
ALTER TABLE `SalesOrder` ADD COLUMN `cancelledById` VARCHAR(191) NULL;
ALTER TABLE `SalesOrder` ADD COLUMN `cancelReason` TEXT NULL;

-- ProjectStatus kennt CANCELLED bereits; hier fehlen nur Zeitpunkt und Grund.
ALTER TABLE `Project` ADD COLUMN `cancelledAt` DATETIME(3) NULL;
ALTER TABLE `Project` ADD COLUMN `cancelledById` VARCHAR(191) NULL;
ALTER TABLE `Project` ADD COLUMN `cancelReason` TEXT NULL;
