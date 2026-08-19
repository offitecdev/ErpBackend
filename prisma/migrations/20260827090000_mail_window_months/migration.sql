-- WIE WEIT DAS POSTFACH ZURUECKREICHT (19.08.2026).
--
-- Bis hierher stand das Fenster fest im Code (zwei Monate). Es gehoert aber in
-- die Einstellungen: wer nur den letzten Monat im ERP haben will, soll das
-- waehlen koennen. Der Wert steuert BEIDES -- wie weit der Abruf im Postfach
-- zurueckliest und welchen Zeitraum die Postfach-Seite aufschlaegt.
--
-- Erlaubt sind 1 und 2; die Vorgabe bleibt 2, damit sich fuer bestehende
-- Mandanten nichts aendert.
ALTER TABLE `MailSetting`
  ADD COLUMN `imapWindowMonths` INT NOT NULL DEFAULT 2;
