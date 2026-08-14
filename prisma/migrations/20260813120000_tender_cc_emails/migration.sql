-- Offerten tragen jetzt eine eigene CC-Liste (Benutzerwunsch 2026-08-13): die
-- Kundenmails der Offerte — die Offertmail und die automatische
-- Auftragsbestätigung beim Erstellen des Auftrags — gehen an den Kunden (To)
-- und in Kopie an diese Adressen.
--
-- Format wie im Kalender (`Appointment.ccEmails` / `MeetingActivity.ccEmails`):
-- ein JSON-Array von Adressen, z. B. ["planer@firma.ch","bauleitung@firma.ch"].
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `Tender` ADD COLUMN `ccEmails` JSON NULL;
