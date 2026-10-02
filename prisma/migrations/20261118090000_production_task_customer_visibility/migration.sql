-- GÖREVLENDİRME › SICHTBAR FÜR DEN KUNDEN (02.10.2026)
--
-- «The customers will be able to see the stages and tasks statuses but admins will
--  select which stages and tasks subtasks can be visible by the customers.»
-- Stufen und Unteraufgaben tragen die Angabe in ihrem JSON; die Aufgabe als Spalte.
--
-- Nur HINZUGEFÜGT: je eine neue Spalte mit Vorgabe «nein» — keine Zeile ändert ihre
-- Bedeutung, nichts umbenannt, nichts gelöscht. Ein älterer Stand des Servers kennt
-- die Spalte nicht und schreibt sie nicht — sie bleibt dann «nein».
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_gorev_sablon_gorevleri` ADD COLUMN `customerVisible` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `uretim_cihaz_gorevleri` ADD COLUMN `customerVisible` BOOLEAN NOT NULL DEFAULT false;
