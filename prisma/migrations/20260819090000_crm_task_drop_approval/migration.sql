-- Aufgaben OHNE Freigabe (19.08.2026).
--
-- Der Freigabe-Lauf von gestern fällt komplett weg: wer eine Aufgabe abhakt,
-- erledigt sie — auch wenn jemand anderes sie zugewiesen hat. Darum:
--   1. gemeldete Aufgaben (PENDING_APPROVAL) gelten als erledigt: sie hatten
--      ihre Arbeit hinter sich und warteten nur noch auf ein Ja. `completedAt`
--      übernimmt den Meldezeitpunkt, damit "Erledigt am" nicht lügt.
--   2. die drei Freigabe-Benachrichtigungen verschwinden — die eine, die
--      bleibt, ist TASK_ASSIGNED ("Ihnen wurde … zugewiesen"). Mit ihnen geht
--      das `requiresAction`-Merkmal, das eine Benachrichtigung unschliessbar
--      machte.
--   3. die drei Spalten des Laufs fallen weg.
--
-- `IF EXISTS` überall: die Datenbank ist MariaDB (kennt das bei DDL) und diese
-- Wanderung soll auch auf einem Bestand laufen, der die Vorgänger-Wanderung
-- noch nicht gesehen hat.

UPDATE `CrmTask`
   SET `status` = 'DONE',
       `completedAt` = COALESCE(`completedAt`, `submittedAt`, NOW(3)),
       `updatedAt` = NOW(3)
 WHERE `status` = 'PENDING_APPROVAL';

DELETE FROM `Notification`
 WHERE `type` IN ('TASK_APPROVAL', 'TASK_APPROVED', 'TASK_REJECTED');

ALTER TABLE `CrmTask` DROP FOREIGN KEY IF EXISTS `CrmTask_approvedByEmployeeId_fkey`;
ALTER TABLE `CrmTask` DROP INDEX IF EXISTS `CrmTask_approvedByEmployeeId_fkey`;
ALTER TABLE `CrmTask`
    DROP COLUMN IF EXISTS `submittedAt`,
    DROP COLUMN IF EXISTS `approvedAt`,
    DROP COLUMN IF EXISTS `approvedByEmployeeId`;
