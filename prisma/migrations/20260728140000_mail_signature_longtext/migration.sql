-- İmza HTML'i Outlook/Word yapıştırmalarıyla satır içi data URI görseller
-- taşıyabilir; TEXT'in 64 KB sınırı buna yetmez.
ALTER TABLE `MailSetting`
    MODIFY COLUMN `signatureHtml` LONGTEXT NULL;
