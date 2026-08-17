-- Personalnummern vergeben (16.08.2026).
-- `staffNumber` kam mit dem Personalmodul-Neubau und war für den gesamten
-- Bestand NULL — die Berichte zeigten deshalb überall „—" statt einer Nummer.
-- Hier wird durchnummeriert, beginnend bei 1, in der Reihenfolge des Eintritts
-- (Anlagedatum). Bereits vergebene Nummern (Sammelanlage) bleiben unangetastet
-- und der Zähler setzt hinter der höchsten von ihnen an, damit nichts kollidiert.
--
-- Die Nummer ist bewusst NICHT nach Firmenbaum getrennt: sie ist eine
-- fortlaufende Personalnummer des Hauses, und die Baum-Zugehörigkeit ist
-- Anwendungswissen, das in reinem SQL nicht sauber nachzubilden wäre.

UPDATE `Employee` AS e
JOIN (
    SELECT
        `id`,
        ROW_NUMBER() OVER (ORDER BY `createdAt` ASC, `id` ASC) AS `rn`
    FROM `Employee`
    WHERE `staffNumber` IS NULL
) AS ordered ON ordered.`id` = e.`id`
CROSS JOIN (
    SELECT COALESCE(MAX(`staffNumber`), 0) AS `offset` FROM `Employee`
) AS base
SET e.`staffNumber` = base.`offset` + ordered.`rn`
WHERE e.`staffNumber` IS NULL;
