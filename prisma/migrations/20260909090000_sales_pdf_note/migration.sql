-- VERKAUFS-PDF (09.09.2026):
--   Der Auftrag trägt die Nachricht des Verkäufers, die auf das goldene
--   Verkaufsdokument gedruckt wird. Sie hängt am AUFTRAG und nicht an der
--   Offerte: das Kundendokument bleibt unverändert, der Auftrag bekommt
--   seinen eigenen Verkaufstext, der jederzeit bearbeitet werden kann.
ALTER TABLE `SalesOrder`
    ADD COLUMN `salesPdfNote` TEXT NULL;
