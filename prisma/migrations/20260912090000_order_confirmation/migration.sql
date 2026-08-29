-- ── AUFTRAGSBESTÄTIGUNG (Benutzerwunsch 29.08.2026) ──────────────────────────
-- Der Beleg, den ein Auftrag dem Kunden schickt, heisst AUFTRAGSBESTÄTIGUNG.
-- Damit ändert sich zweierlei:
--
--   1. Der Code trägt ab jetzt das Präfix `AB-` statt `AU-`. Neue Codes kommen
--      aus `shared/documentNumber.ts` (DOCUMENT_PREFIX.ORDER = 'AB'); die
--      BEREITS VERGEBENEN werden hier umgeschrieben — sonst sähe der Bestand
--      anders aus als jede neue Bestätigung, und die Blockrückkehr des Zählers
--      (REGEXP auf das Präfix) würde die alten Nummern nicht mehr sehen und
--      eine Sequenz ein zweites Mal vergeben.
--
--   2. Der Auftrag bekommt zwei eigene Felder für das Dokument: den
--      Einleitungstext der Titelseite und das «Gültig bis»-Datum. Beide sind
--      NULL, solange niemand sie bearbeitet hat — dann gelten die Vorgaben
--      (Text = Einleitungstext der Offerte, Gültigkeit = Auftragsdatum + 1 Monat).
--
-- Nur `SalesOrder` ist betroffen. Die Einkaufsbestellung (`PurchaseOrder`)
-- führt ihre eigene BE-Serie und kennt aus einem Ein-Tages-Fenster im August
-- ebenfalls `AU-`-Codes — die bleiben unangetastet.

ALTER TABLE `SalesOrder`
    ADD COLUMN `confirmationNote` LONGTEXT NULL,
    ADD COLUMN `confirmationValidUntil` DATETIME(3) NULL;

-- Der bisherige Code bleibt auffindbar (Listenfilter und CSV-Import matchen auf
-- `legacyNumber`) — aber nur, wenn dort noch nichts Älteres steht: eine schon
-- einmal umnummerierte Bestellung darf ihren ORIGINALCODE nicht verlieren.
UPDATE `SalesOrder`
SET `legacyNumber` = `orderNumber`
WHERE `orderNumber` LIKE 'AU-%'
  AND (`legacyNumber` IS NULL OR `legacyNumber` = '');

-- Nur das Präfix ändert sich; Jahr, Sequenz und ein etwaiger Versionssuffix
-- (`-2`, `-3`) bleiben stehen: AU-2026-10046-2 → AB-2026-10046-2.
UPDATE `SalesOrder`
SET `orderNumber` = CONCAT('AB-', SUBSTRING(`orderNumber`, 4))
WHERE `orderNumber` LIKE 'AU-%';
