-- Erinnerungen (Benutzerwunsch 2026-08-14): eine fällige Erinnerung blendet
-- rechts ein Fenster ein. `notifiedAt` hält fest, dass sie gezeigt wurde —
-- ohne den Stempel poppt dieselbe Erinnerung bei jeder Abfrage erneut auf.
--
-- Der Index bedient genau die Abfrage des Weckers (Mandant + kind=REMINDER +
-- noch nicht gezeigt + fällig); sie läuft im Minutentakt und darf die Tabelle
-- nicht scannen.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `CrmTask` ADD COLUMN `notifiedAt` DATETIME(3) NULL;

CREATE INDEX `CrmTask_tenantId_kind_notifiedAt_dueDate_idx`
    ON `CrmTask`(`tenantId`, `kind`, `notifiedAt`, `dueDate`);
