-- POSTFACH-UMBAU (08.09.2026):
--   1. MailCategory — die persönliche Ordnung des Firmenpostfachs. Eine
--      Kategorie hängt an Person/Kunde/Angebot/Auftrag/Projekt/Rechnung oder
--      ist die eingebaute Sammelkategorie «Anfragen» (REQUESTS).
--   2. MailMessage.categoryId — Zuordnung per Klick oder Ziehen.
--   3. MailMessage.deletedAt — Papierkorb: Löschen legt die Nachricht erst
--      dorthin; endgültig gelöscht wird nur aus dem Papierkorb.
--   4. MailMessage.bodyHtml — bereinigtes HTML (fett, Listen, Tabellen),
--      damit die Post wie im Mailprogramm liest; bodyText bleibt für
--      Vorschau und Suche.
CREATE TABLE `MailCategory` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `entityId` VARCHAR(191) NULL,
    `name` VARCHAR(160) NOT NULL,
    `color` VARCHAR(16) NOT NULL,
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MailCategory_tenantId_kind_entityId_key`(`tenantId`, `kind`, `entityId`),
    INDEX `MailCategory_tenantId_displayOrder_idx`(`tenantId`, `displayOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MailMessage`
    ADD COLUMN `categoryId` VARCHAR(191) NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `bodyHtml` MEDIUMTEXT NULL;

CREATE INDEX `MailMessage_tenantId_categoryId_sentAt_idx` ON `MailMessage`(`tenantId`, `categoryId`, `sentAt`);
CREATE INDEX `MailMessage_tenantId_deletedAt_sentAt_idx` ON `MailMessage`(`tenantId`, `deletedAt`, `sentAt`);

ALTER TABLE `MailMessage` ADD CONSTRAINT `MailMessage_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `MailCategory`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- EINMALIG: Lesestand verwerfen. Der Abruf übernimmt ab jetzt ALLES aus dem
-- Fenster (2 Monate), nicht mehr nur Post bekannter Adressen — dafür muss der
-- Ordner einmal vom Fensteranfang neu gelesen werden. Schon gespeicherte
-- Nachrichten werden an der Message-ID erkannt und nicht doppelt angelegt.
UPDATE `MailSetting`
   SET `imapUidValidity` = NULL, `imapLastUid` = NULL,
       `imapSentUidValidity` = NULL, `imapSentLastUid` = NULL;
