-- Die Bestellung merkt sich, welche Spalten ihre Vorlage ausgeblendet hatte:
-- das PDF wird spaeter ohne die Vorlage neu gebaut und muss es trotzdem wissen.
-- NULL = nichts ausgeblendet; die Werte selbst bleiben in `items`.
ALTER TABLE `PurchaseOrder`
    ADD COLUMN `hiddenColumnKeys` TEXT NULL;
