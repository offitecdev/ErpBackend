-- OSP (16.09.2026): die dritte Vertragsfassung von offer-integration-api.md.
--
-- Neu darin:
--  * §1 nennt die Adressen des AUFTRAGS getrennt (Projekt / Lieferung /
--    Rechnung) und dazu eine Rufnummer fuer dieses Projekt.
--  * §1a schickt eine UEBERARBEITETE Anfrage - dieselbe Referenz, neu
--    gerechnet. Die Zeile merkt sich, dass und wann das geschah.
--  * §1b meldet, dass die anfragende Person ihre Anfrage zurueckgezogen hat.
--    Geloescht wird dabei nichts: die Zeile wechselt auf WITHDRAWN und behaelt
--    Offerte, Datenblatt und Zustaendigkeit.
--  * §3 darf die Verkaeuferin/den Verkaeufer als OBJEKT melden. Es wird als
--    Ganzes abgelegt, damit die anfragende Person drueben einen Namen sieht
--    und nicht bloss eine E-Mail-Adresse.
ALTER TABLE `OspDocument`
    ADD COLUMN `phone` VARCHAR(191) NULL,
    ADD COLUMN `shippingAddress` TEXT NULL,
    ADD COLUMN `billingAddress` TEXT NULL,
    ADD COLUMN `salespersonProfile` JSON NULL,
    ADD COLUMN `withdrawnAt` DATETIME(3) NULL,
    ADD COLUMN `withdrawnByName` VARCHAR(191) NULL,
    ADD COLUMN `withdrawnByEmail` VARCHAR(191) NULL,
    ADD COLUMN `withdrawnFromStatus` VARCHAR(191) NULL,
    ADD COLUMN `revisedAt` DATETIME(3) NULL,
    ADD COLUMN `revisionCount` INTEGER NOT NULL DEFAULT 0;
