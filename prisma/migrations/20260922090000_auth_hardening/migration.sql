-- Anmeldung/Zugang, drei Korrekturen (22.09.2026).
--
-- 1) `Employee.deactivatedAt` — WER SICH SELBST WIEDER FREISCHALTEN KONNTE
--
--    `/auth/activation/request` schickt jedem INAKTIVEN Konto einen
--    Aktivierungslink an seine eigene Adresse. Gedacht war das fuer ein Konto,
--    das noch nie freigeschaltet wurde. Tatsaechlich traf es genauso das Konto,
--    das die Verwaltung eben stillgelegt hatte: eine ausgetretene Person
--    forderte den Link an, bestaetigte ihn und war wieder drin.
--
--    Die Spalte trennt beides. Sie wird gesetzt, sobald ein Konto stillgelegt,
--    gesperrt oder geloescht wird, und geleert, sobald die Verwaltung es wieder
--    aktiv setzt. Der Aktivierungsweg lehnt ab, solange sie steht.
--
--    ALTBESTAND: jedes heute inaktive Konto gilt als von der Verwaltung
--    stillgelegt. Das ist die sichere Richtung — ein wirklich neues Konto
--    schaltet die Verwaltung frei, ein ausgetretenes bleibt draussen.
--
-- 2) `RefreshSession` — DIE ABMELDUNG, DIE KEINE WAR
--
--    Erneuerungstoken galten 30 Tage und wurden bei jeder Erneuerung getauscht,
--    aber nie entwertet: das alte blieb gueltig, und das Abmelden loeschte nur
--    die Keks im Browser. Jede Anmeldung bekommt jetzt eine Zeile, das Token
--    traegt deren Kennung, und Abmelden/Sperre/Kennwortwechsel entwerten sie.
--    Wird ein bereits getauschtes Token noch einmal vorgelegt, faellt die ganze
--    Anmeldefamilie (`familyId`).
--
--    Nach dem Aufspielen sind alle bestehenden Erneuerungstoken ungueltig (sie
--    tragen noch keine Kennung) — alle Angemeldeten melden sich einmal neu an.

ALTER TABLE `Employee`
    ADD COLUMN `deactivatedAt` DATETIME(3) NULL;

UPDATE `Employee`
   SET `deactivatedAt` = COALESCE(`bannedAt`, `deletedAt`, `terminationDate`, `updatedAt`, NOW())
 WHERE `isActive` = 0;

CREATE TABLE `RefreshSession` (
    `id`            VARCHAR(191) NOT NULL,
    `familyId`      VARCHAR(191) NOT NULL,
    `employeeId`    VARCHAR(191) NOT NULL,
    `tenantId`      VARCHAR(191) NOT NULL,
    `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt`     DATETIME(3)  NOT NULL,
    `revokedAt`     DATETIME(3)  NULL,
    `revokedReason` VARCHAR(32)  NULL,
    `replacedById`  VARCHAR(191) NULL,
    `userAgent`     VARCHAR(512) NULL,
    `ipAddress`     VARCHAR(64)  NULL,

    INDEX `RefreshSession_employeeId_idx`(`employeeId`),
    INDEX `RefreshSession_familyId_idx`(`familyId`),
    INDEX `RefreshSession_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RefreshSession`
    ADD CONSTRAINT `RefreshSession_employeeId_fkey`
    FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
