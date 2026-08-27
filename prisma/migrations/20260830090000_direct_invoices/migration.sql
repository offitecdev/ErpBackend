-- DIREKTRECHNUNG — DIE LEERE VORLAGE (30.08.2026).
--
-- Vorgabe Samet: neben der Rechnung AUS EINEM AUFTRAG soll es eine Rechnung
-- geben, die man selbst ausfuellt: Empfaenger waehlen, Positionen aus dem
-- Katalog holen oder von Hand tippen, Preise setzen — fertig ist das PDF.
--
-- So eine Rechnung haengt an keinem Auftrag und an keinem Projekt. Alles, was
-- die Auftragsrechnung aus der Offerte nachliest (Empfaengeradresse, Steuersatz,
-- Einleitungstext), muss sie deshalb selbst tragen. Genau dafuer sind diese
-- Spalten da; bei einer Auftragsrechnung bleiben sie NULL und der PDF-Bau geht
-- weiter ueber die Offerte.
--
-- Die Positionszeile bekommt zwei Angaben dazu, die eine Pauschalzeile nie
-- brauchte: ihre Mengeneinheit und ihren Platz auf dem Beleg.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `Invoice`
    ADD COLUMN `recipientName` VARCHAR(191) NULL,
    ADD COLUMN `recipientAddress` TEXT NULL,
    ADD COLUMN `introText` TEXT NULL,
    ADD COLUMN `vatRate` DOUBLE NULL;

ALTER TABLE `InvoiceLineItem`
    ADD COLUMN `unit` VARCHAR(191) NULL,
    ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

-- Die Liste sortiert nach Rechnungsdatum; ohne diesen Schluessel laeuft sie als
-- Sortierung ueber die ganze Tabelle.
CREATE INDEX `Invoice_tenantId_invoiceDate_idx` ON `Invoice`(`tenantId`, `invoiceDate`);
