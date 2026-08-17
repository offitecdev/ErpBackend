-- Daumennagel des Profilbildes (18.08.2026).
--
-- Ab jetzt IST das Profilbild die Person: es steht in der Personalliste, im
-- Kopfband, an jeder Zuteilung — überall dort, wo vorher Vor- und Nachname
-- standen. Das grosse Bild (512 px, ~100 KB als Daten-URL) an jeden dieser
-- Plätze zu schicken wäre bei 100 Personen ein Ladegewicht von ~10 MB.
--
-- Deshalb liegt daneben derselbe Kopf noch einmal in 64 px (~2 KB). Erzeugt
-- wird er im Browser, gemeinsam mit dem grossen Bild.
--
-- Bestehende Bilder behalten einen leeren Daumennagel; die Kurzliste fällt
-- dafür auf `profilePictureUrl` zurück, bis das Bild einmal neu gesetzt wird.

ALTER TABLE `Employee`
    ADD COLUMN `profilePictureThumb` MEDIUMTEXT NULL AFTER `profilePictureUrl`;
