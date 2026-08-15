-- Aufgaben & Erinnerungen (Benutzerwunsch 15.08.2026):
--   * `contactId` — die Kundenwahl schliesst den Ansprechpartner ein
--     (Schnellerfassung, Aufgabe/Erinnerung); wie bei CrmCommunication.
--   * `entityType`/`entityId` — der Beleg hinter einer Erinnerung des
--     Hintergrunddienstes (QUOTE → Tender, ORDER → SalesOrder). Läuft das
--     Angebot ab oder ist der Auftrag zu, räumt der Dienst die Erinnerung
--     weg. Bestehende Erinnerungen werden aus ihrem Sprungziel nachgetragen.
--   * Status kennt neu INCOMPLETE ("Nicht erledigt") — nur ein weiterer Wert
--     in der bestehenden Textspalte, keine Änderung am Schema.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `CrmTask`
    ADD COLUMN `contactId` VARCHAR(191) NULL,
    ADD COLUMN `entityType` VARCHAR(191) NULL,
    ADD COLUMN `entityId` VARCHAR(191) NULL;

CREATE INDEX `CrmTask_contactId_idx` ON `CrmTask`(`contactId`);
CREATE INDEX `CrmTask_entityType_entityId_idx` ON `CrmTask`(`entityType`, `entityId`);

ALTER TABLE `CrmTask` ADD CONSTRAINT `CrmTask_contactId_fkey`
    FOREIGN KEY (`contactId`) REFERENCES `CustomerContact`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Nachtrag: /sales/quotes/<id> → QUOTE, /sales/orders/<id> → ORDER.
UPDATE `CrmTask`
   SET `entityType` = 'QUOTE', `entityId` = SUBSTRING_INDEX(`linkUrl`, '/', -1)
 WHERE `kind` = 'REMINDER' AND `linkUrl` LIKE '/sales/quotes/%';

UPDATE `CrmTask`
   SET `entityType` = 'ORDER', `entityId` = SUBSTRING_INDEX(`linkUrl`, '/', -1)
 WHERE `kind` = 'REMINDER' AND `linkUrl` LIKE '/sales/orders/%';
