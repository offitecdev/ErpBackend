-- POSTEINGANG DES EIGENEN MAILSERVERS (Vorgabe 18.08.2026).
--
-- Ausgehende Mail geht über den eigenen SMTP-Server (nodemailer), eingehende
-- wird per IMAP von demselben Server geholt — Outlook Online faellt weg, weil
-- jenes Postfach nicht mit dem Server-Postfach abgeglichen ist.
--
-- Es wird NICHT das ganze Postfach gespeichert: nur Antworten auf ERP-Mails
-- (In-Reply-To / References zeigen auf eine von uns vergebene Message-ID) und
-- Nachrichten bekannter Kunden-/Ansprechpartneradressen. Der Rest wird gelesen,
-- verworfen und nie abgelegt.
--
-- Die Zugangsdaten stehen schon in den IMAP-Spalten der Gesendet-Kopie; hier
-- kommen nur Schalter und der Lesefortschritt dazu.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `MailSetting`
    ADD COLUMN `imapCaptureEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `imapInboxFolder` VARCHAR(191) NULL,
    ADD COLUMN `imapCaptureRepliesOnly` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `imapUidValidity` BIGINT NULL,
    ADD COLUMN `imapLastUid` BIGINT NULL,
    ADD COLUMN `imapLastSyncAt` DATETIME(3) NULL,
    ADD COLUMN `imapLastError` TEXT NULL,
    ADD COLUMN `imapLastSummary` VARCHAR(255) NULL;
