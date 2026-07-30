-- Tenant e-posta imzası: zengin metin + opsiyonel görsel.
--
-- `signatureHtml` imza editöründen gelen sınırlı HTML'i, `signatureImage`
-- yüklenen/yapıştırılan görselin data URI'sini tutar. Görsel gönderim anında
-- CID'li inline eke çevrilir (data URI'ler mail istemcilerinde engellenir).
ALTER TABLE `MailSetting`
    ADD COLUMN `signatureHtml` TEXT NULL,
    ADD COLUMN `signatureImage` LONGTEXT NULL;
