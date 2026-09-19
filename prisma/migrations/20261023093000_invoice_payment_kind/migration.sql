-- PAYMENT = Geld ist geflossen (Eingang, bei der Gutschrift: Rückzahlung).
-- OFFSET  = mit einer offenen Rechnung verrechnet — kein Geldfluss (17.09.2026).
ALTER TABLE `InvoicePayment` ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'PAYMENT';
