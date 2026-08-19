-- Umfirmierung: „Offitec Group AG" heisst neu „Offitec GmbH" (19.08.2026).
--
-- Der Name steht als reiner Datensatz in `Tenant.tenantName` und taucht in der
-- Firmenumschaltung, in den Rollen-/Berechtigungsansichten und in den
-- Firmenkategorien auf — es gibt keine Oberfläche zum Umbenennen, deshalb hier.
--
-- Nur der exakte alte Name wird ersetzt (die Kollation der Spalte vergleicht
-- ohne Gross-/Kleinschreibung, `TRIM` fängt gespeicherte Randleerzeichen ab).
-- Untergesellschaften mit eigenem Namen bleiben unangetastet, und ein
-- wiederholter Lauf ist wirkungslos, weil der neue Name nicht mehr passt.
--
-- Das Gegenstück auf der Druckseite ist `pdfSettingsStore` (Version 6): dort
-- wird derselbe Name für Absenderzeile und QR-Rechnungs-Gläubiger gesetzt.

UPDATE `Tenant`
SET `tenantName` = 'Offitec GmbH'
WHERE TRIM(`tenantName`) = 'Offitec Group AG';
