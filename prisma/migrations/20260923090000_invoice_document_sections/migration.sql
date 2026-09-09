-- Die drei Abschnitte der Direktrechnung (Positionen · Rabatt · Schlusstext),
-- ihr Rabattstapel, die eigene Absenderzeile und der Zahlungseingang.
--
-- Alle Spalten sind NULLbar: eine bestehende Rechnung behaelt damit genau ihr
-- heutiges Aussehen (`sections` NULL = alle drei Abschnitte drucken).
ALTER TABLE `Invoice`
  ADD COLUMN `sections` TEXT NULL,
  ADD COLUMN `discounts` TEXT NULL,
  ADD COLUMN `closingText` TEXT NULL,
  ADD COLUMN `senderAddress` TEXT NULL,
  ADD COLUMN `paidAt` DATETIME(3) NULL;

-- Bereits bezahlte Rechnungen bekommen ein Zahlungsdatum, damit die neue
-- Spalte nicht mit einer Luecke startet: das letzte Aenderungsdatum ist der
-- Zeitpunkt, an dem sie auf PAID gesetzt wurden.
UPDATE `Invoice` SET `paidAt` = `updatedAt` WHERE `status` = 'PAID' AND `paidAt` IS NULL;
