-- GÖNDERİLENLER KOPYASI (user request 2026-08-04): mails sent from the ERP
-- reached the recipient but never showed up in the sender's "Sent Items".
-- That is inherent to SMTP: it is a DELIVERY protocol and leaves no trace in
-- the sender's own mailbox. Outlook only shows sent mail because the client
-- performs a separate IMAP APPEND afterwards. The backend now does the same
-- step, so MailSetting gains its IMAP half.
--
-- imapHost NULL/empty = feature off (nothing is copied).
-- imapUser/imapPassword empty = the SMTP credentials are reused.
-- sentFolder NULL = folder auto-detected (RFC 6154 `\Sent`, then known names).
-- saveToSent = 0 for Exchange tenants that already file the copy server-side
-- (MessageCopyForSMTPClientSubmissionEnabled), otherwise the mail appears twice.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `MailSetting`
    ADD COLUMN `imapHost` VARCHAR(191) NULL,
    ADD COLUMN `imapPort` INTEGER NOT NULL DEFAULT 993,
    ADD COLUMN `imapSecure` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `imapUser` VARCHAR(191) NULL,
    ADD COLUMN `imapPassword` TEXT NULL,
    ADD COLUMN `sentFolder` VARCHAR(191) NULL,
    ADD COLUMN `saveToSent` BOOLEAN NOT NULL DEFAULT true;
