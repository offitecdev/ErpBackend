-- Die Rechnungszeile bekommt dieselben Felder wie eine Offertposition:
-- Beschreibung unter der Bezeichnung sowie den Zeilenrabatt (Stapel + sein
-- kombinierter Prozentwert). Damit druckt die Rechnung dieselbe Tabelle wie
-- das Angebot.
ALTER TABLE `InvoiceLineItem`
  ADD COLUMN `longDescription` TEXT NULL,
  ADD COLUMN `discounts` TEXT NULL,
  ADD COLUMN `discount` DOUBLE NULL;
