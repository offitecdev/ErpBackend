-- FIRMENWECHSEL ALS ROLLENRECHT (31.08.2026, Vorgabe)
--
-- Bis hierher entschied allein `Employee.allowedTenantIds`, welche Firmen der
-- Umschalter im Kopf anbot: keine Zuteilung = die eigene Firma, sonst genau die
-- angehakten. Verwaltung und Projektleitung arbeiten aber ueber alle Haeuser
-- hinweg und mussten in JEDER neuen Firma einzeln nachgetragen werden.
--
-- Ab jetzt traegt die ROLLE das Recht. Der Vorgabewert ist bewusst `false`:
-- der Umbau darf keiner bestehenden Rolle stillschweigend die Schwesterfirmen
-- oeffnen. Die Administratorrolle braucht die Spalte nicht — sie gilt im Code
-- ueber `Role.isSystemAdmin` als immer berechtigt.
ALTER TABLE `Role`
    ADD COLUMN `canSwitchTenant` BOOLEAN NOT NULL DEFAULT false;
