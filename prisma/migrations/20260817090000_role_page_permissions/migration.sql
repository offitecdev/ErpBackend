-- Rollenvorlagen mit Seitenrechten (17.08.2026).
--
-- Die Berechtigungstabelle steht ab jetzt Modul für Modul und Seite für Seite;
-- die gewählte Stufe je Seite lebt als Karte auf der Rolle. Die bestehenden
-- RolePermission-Zeilen bleiben die Autorität der Server-Prüfungen — sie werden
-- beim Speichern aus dieser Karte ABGELEITET.
--
-- `pageLevels` bleibt bei Altrollen NULL: der Server rechnet ihre Stufenkarte
-- beim Lesen aus den vorhandenen Rechten zurück (pageCatalog.pageLevelsFromPermissions),
-- damit nach dem Aufspielen niemand vor einem leeren Menü steht.

ALTER TABLE `Role`
    ADD COLUMN `pageLevels` JSON NULL,
    ADD COLUMN `isSystemAdmin` BOOLEAN NOT NULL DEFAULT false;

-- ── Kennwortwunsch aus dem eigenen Profil ────────────────────────────────────
-- Wer nicht verwaltet, ändert sein Kennwort nicht selbst, sondern beantragt es.
-- Der Entwurf liegt bereits als bcrypt-Hash hier; Klartext wird nie gespeichert.
CREATE TABLE `PasswordChangeRequest` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `newPasswordHash` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `note` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `decidedById` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PasswordChangeRequest_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `PasswordChangeRequest_employeeId_status_idx`(`employeeId`, `status`),
    INDEX `PasswordChangeRequest_decidedById_fkey`(`decidedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PasswordChangeRequest`
    ADD CONSTRAINT `PasswordChangeRequest_employeeId_fkey`
    FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PasswordChangeRequest`
    ADD CONSTRAINT `PasswordChangeRequest_decidedById_fkey`
    FOREIGN KEY (`decidedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
