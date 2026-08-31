-- OSP (19.09.2026): nur noch die VERKAEUFERIN/der VERKAEUFER wird gewaehlt.
--
-- Die Projektleitung war eine rein interne zweite Zustaendigkeit an der
-- OSP-Zeile; gemeldet wurde sie nie. Sie faellt weg (Benutzerwunsch): auf der
-- Anfrage steht die eine Person, die die Offerte macht - und genau die geht
-- als `salesman` an die OSP.
--
-- Die Spalten bleiben stehen, wie schon `salespersonRole`: geloescht wird
-- nichts, was alte Zeilen ueber ihre Herkunft erzaehlen. Sie werden nur nicht
-- mehr geschrieben und nicht mehr gelesen.
--
-- Neu dazu: `revisionSeenAt`. Kommt dieselbe Anfrage neu gerechnet zurueck
-- (§1a), warnt die Offerte, dass ihr Datenblatt nicht mehr gilt. Wer die
-- Warnung zur Kenntnis nimmt, stempelt hier - solange `revisedAt` juenger ist
-- als dieser Stempel, steht die Warnung.
ALTER TABLE `OspDocument`
    ADD COLUMN `revisionSeenAt` DATETIME(3) NULL;
