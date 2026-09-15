-- Görevler: Gün sonu raporu penceresinin bitiş saati (15.09.2026, Samet):
-- rapor yalnızca promptTime–endTime arasında yazılabilir (varsayılan 16:00–17:00).
ALTER TABLE `TaskDailyReportSetting` ADD COLUMN `endTime` VARCHAR(5) NOT NULL DEFAULT '17:00';
