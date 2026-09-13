-- Görevler: die Einführungsaufgabe wird nach dem Abschluss gelöscht (14.09.2026, Samet).
-- Diese Spalte merkt sich das, sonst legte der nächste Aufruf sie neu an.
ALTER TABLE `TaskUserSetting` ADD COLUMN `onboardingDoneVersion` VARCHAR(40) NULL;
