-- TERMINUNTERLAGEN LIEGEN AUF DER PLATTE (24.08.2026).
--
-- Vorgabe Samet: «Das Anhängen muss richtig schnell gehen — so schnell, wie wir
-- Dateien an ein Angebot hängen.» Genau das ist der Unterschied: die
-- Angebotsanhänge reisen als ROHE Datei (multipart) und landen als Datei auf
-- dem Datenträger; in der Datenbank steht nur ein kurzer Verweis. Base64 in
-- einem JSON-Körper ist ein Drittel grösser, muss zweimal umkodiert werden und
-- schreibt am Ende Megabyte in eine LONGTEXT-Spalte.
--
-- Die Spalte wird deshalb von LONGTEXT (Daten-URI) auf einen Verweis
-- umgestellt. Zeilen gibt es noch keine — die Unterlagen sind an diesem Tag
-- entstanden —, es geht also nichts verloren.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `AppointmentDocument`
    DROP COLUMN `data`,
    ADD COLUMN `fileRef` VARCHAR(512) NOT NULL;
