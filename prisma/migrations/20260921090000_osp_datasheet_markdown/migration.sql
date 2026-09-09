-- OSP (21.09.2026): das Datenblatt als MARKDOWN an der Einheit.
--
-- Zwei Dinge waren kaputt, und beide haengen an derselben Stelle:
--
--  * Die Angaben wurden mit Suchmustern ueber den ganzen PDF-Text gelesen. Aus
--    dem Hinweissatz "differing medium concentrations ..." wurde so das Medium
--    "concentrations" - und genau das stand auf der Offerte. Gelesen wird jetzt
--    aus den ZEILEN des Blattes (Abschnitt, Bezeichnung, Einheit, Wert).
--  * Es gab keine lesbare Fassung des Blattes. Wer eine Zahl nachpruefen
--    wollte, musste das PDF oeffnen - und wenn die Datei fehlte, ging gar
--    nichts mehr.
--
-- Die Markdown-Fassung ist beides: die QUELLE der Produktangaben und die
-- lesbare Fassung des Blattes. Sie liegt in der Datenbank, weil sie Text ist,
-- den man sucht und anzeigt - keine Datei.
ALTER TABLE `OspUnit`
    ADD COLUMN `datasheetMarkdown` MEDIUMTEXT NULL,
    ADD COLUMN `markdownUrl` TEXT NULL,
    ADD COLUMN `markdownFetchedAt` DATETIME(3) NULL;
