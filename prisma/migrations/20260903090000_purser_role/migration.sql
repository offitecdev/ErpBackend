-- Feste Purser-Rolle (27.08.2026): die zweite Stufe des Antragswegs hängt an
-- einer Rolle aus den Einstellungen, nicht mehr an der Personalrolle ACCOUNTANT.
ALTER TABLE `Role`
    ADD COLUMN `isPurser` BOOLEAN NOT NULL DEFAULT false;
