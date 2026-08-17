-- „Sonstiger Urlaub" mit Freitext (16.08.2026).
-- Der Jahresurlaub ist keine eigene Auswahl mehr: er wird als leaveType
-- 'OTHER' erfasst und im Freitext benannt.

ALTER TABLE `StaffLeaveRequest`
    ADD COLUMN `leaveTypeLabel` VARCHAR(120) NULL;

-- Bestehende Jahresurlaub-Anträge auf die neue Art umstellen und ihre
-- bisherige Bedeutung im Freitext festhalten, damit Rapporte über vergangene
-- Zeiträume weiterhin "Jahresurlaub" ausweisen statt eines rohen Schlüssels.
UPDATE `StaffLeaveRequest`
   SET `leaveTypeLabel` = 'Jahresurlaub',
       `leaveType` = 'OTHER'
 WHERE `leaveType` = 'ANNUAL_PAID';
