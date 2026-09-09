-- Zweiter Faktor an der Anmeldung (29.09.2026).
--
-- Kennwort allein oeffnet das Programm nicht mehr. Nach der richtigen
-- Kennworteingabe verlangt die Anmeldung einen sechsstelligen Code, den eine
-- Authenticator-App auf dem Telefon der Person aus einem gemeinsamen Geheimnis
-- und der Uhrzeit rechnet (TOTP, RFC 6238). Empfohlen wird Aegis; die
-- Rechenvorschrift ist ein offener Standard, es geht jede App.
--
-- DREI SPALTEN, MEHR BRAUCHT ES NICHT:
--
--   totpSecret     Das gemeinsame Geheimnis, VERSCHLUESSELT abgelegt
--                  (`enc:v1:…`, AES-256-GCM mit einem aus
--                  OFFITEC_CRYPTO_MASTER_KEY abgeleiteten Schluessel).
--                  Im Klartext waere eine ausgelesene Tabelle zugleich der
--                  zweite Faktor jeder Person — die Massnahme waere dann nur
--                  noch eine Unbequemlichkeit.
--
--   totpEnabledAt  Gesetzt, sobald der ERSTE Code bestaetigt wurde. Solange
--                  sie leer ist, fuehrt die Anmeldung durch die Einrichtung
--                  (QR-Bild scannen, ersten Code eingeben) statt sie zu
--                  ueberspringen. Der Faktor ist damit fuer JEDEN Pflicht,
--                  ohne dass jemand vorher etwas verteilen muss.
--
--   totpLastStep   Das zuletzt angenommene Zeitfenster (Unixsekunden / 30).
--                  Ein Code gilt genau EINMAL. Ohne diese Spalte koennte ein
--                  abgelesener Code (Schulterblick, Protokoll eines
--                  Zwischenservers) innerhalb seiner dreissig Sekunden ein
--                  zweites Mal anmelden.
--
-- ALTBESTAND: alle drei Spalten sind NULL. Das heisst "noch nicht
-- eingerichtet" — jede bestehende Person wird bei ihrer naechsten Anmeldung
-- einmal durch die Einrichtung gefuehrt. Es geht kein Zugang verloren, und es
-- muss nichts vorbereitet werden.
--
-- ZURUECKNEHMEN: die drei Spalten fallen zu lassen genuegt; es haengt nichts
-- daran. Wer nur den Zwang loesen will, ohne die Einrichtungen zu verlieren,
-- nimmt stattdessen den Aufruf in LoginUseCase heraus.
--
-- NEUE UMGEBUNGSVARIABLE: OFFITEC_JWT_MFA_SECRET (Base64, mind. 32 Byte,
-- verschieden von den fuenf anderen). Das Zwischentoken zwischen Kennwort- und
-- Codeeingabe wird damit unterschrieben. Fehlt sie, scheitert die Anmeldung —
-- wie bei jedem anderen JWT-Geheimnis auch.

ALTER TABLE `Employee`
    ADD COLUMN `totpSecret` VARCHAR(255) NULL,
    ADD COLUMN `totpEnabledAt` DATETIME(3) NULL,
    ADD COLUMN `totpLastStep` INT NULL;
