-- Die Spalten der Vorlage an der Bestellung (11.09.2026).
--
-- Eine Bestellung merkt sich, mit welchen Spalten sie erfasst wurde:
-- JSON [{key, name, label, type}] in der Reihenfolge der Vorlage. Das PDF
-- wird auf dem Client ohne die Vorlage gebaut und schreibt diese Namen als
-- Spaltentitel ("GESAMTMENGE" statt "Menge") in dieser Reihenfolge.
-- NULL = alte Bestellung ohne Schnappschuss (das PDF nimmt seine eigenen Titel).

ALTER TABLE `PurchaseOrder`
    ADD COLUMN `tableColumns` TEXT NULL;
