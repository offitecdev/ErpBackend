-- GESENDETE POST VOM EIGENEN SERVER (19.08.2026).
--
-- Bis hierher las der Abruf nur den Posteingang. Was jemand aus Outlook heraus
-- verschickt, landet aber im Ordner "Gesendet" und blieb damit ausserhalb des
-- ERP -- die Kundenkommunikation zeigte nur die eine Haelfte des Gespraechs.
--
-- Der Ordner braucht einen EIGENEN Lesestand: seine UIDs haben mit denen des
-- Posteingangs nichts zu tun. Der Ordnername steht schon in `sentFolder`
-- (dieselbe Angabe, die die Gesendet-Kopie nach dem Versand benutzt); ist er
-- leer, sucht der Abruf ihn am `\Sent`-Merkmal des Servers.
ALTER TABLE `MailSetting`
  ADD COLUMN `imapSentUidValidity` BIGINT NULL,
  ADD COLUMN `imapSentLastUid` BIGINT NULL;
