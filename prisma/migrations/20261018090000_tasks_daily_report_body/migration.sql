-- Görevler: Gün sonu raporu = EIN freies Blatt (16.09.2026, Samet: «madde madde olmayacak,
-- direkt beyaz bir sayfa, markdown, görsel ekleyebilecek; görseller ve pdf'ler ekleti olarak
-- tıklanabilir url olarak yer alacak»).
--   `body`      der Markdown-Text des Tages (die alten `items` bleiben für alte Rapporte stehen)
--   `dailyDate` an TaskAttachment: eine Datei, die zu KEINER Aufgabe gehört, sondern zum
--               Gün sonu raporu einer Person an einem Kalendertag (kind = 'DAILY').
ALTER TABLE `TaskDailyReport`
    ADD COLUMN `body` MEDIUMTEXT NULL;

ALTER TABLE `TaskAttachment`
    ADD COLUMN `dailyDate` VARCHAR(10) NULL;

CREATE INDEX `TaskAttachment_tenantId_uploadedById_dailyDate_idx`
    ON `TaskAttachment`(`tenantId`, `uploadedById`, `dailyDate`);
