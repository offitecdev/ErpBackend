-- Kundenreferenz on the offer + reusable intro-text templates (Textbausteine).
--
-- 1) `Tender.customerReference` — the reference the CUSTOMER supplied; printed
--    as "Referenz" in the offer PDF's info card (commissionNumber stays "Kommission").
-- 2) `TenderTextTemplate` — tenant-wide reusable Einleitungstext templates for
--    the offer's cover letter. `isDefault` marks the one pre-filled into new
--    offers. Two templates are seeded per tenant: the OffiTec heat-pump intro
--    (default) and a general fallback intro.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `Tender`
    ADD COLUMN `customerReference` VARCHAR(191) NULL;

CREATE TABLE IF NOT EXISTS `TenderTextTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `content` LONGTEXT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `TenderTextTemplate_tenantId_idx` ON `TenderTextTemplate`(`tenantId`);

-- Seed: OffiTec heat-pump intro (the current standard text) as the DEFAULT …
INSERT INTO `TenderTextTemplate` (`id`, `tenantId`, `title`, `content`, `isDefault`, `createdAt`, `updatedAt`)
SELECT
    UUID(),
    t.`id`,
    'Einleitung Wärmepumpe (IWB Trakt T)',
    CONCAT(
        '<p><strong>Vielen Dank für Ihre Anfrage für das Projekt IWB Trakt T:</strong></p>',
        '<p>1x Wasser/Wasser Wärmepumpe mit dem Kältemittel R290 (Innenaufstellung)<br>1x Rückkühler V-form</p>',
        '<p><strong>Leistungen OffiTec Heating &amp; Cooling:</strong></p>',
        '<ul>',
        '<li>Aufbau &amp; Lieferung Wärmepumpe inkl. Steuerschrank &amp; Gummischwingungsdämpfer.</li>',
        '<li>Factory acceptance test - mit oder ohne Kunde (Kundenwunsch).</li>',
        '<li>Lieferung Bordsteinkante (Ablad Bauseits).</li>',
        '<li>Anmeldung (Vignette) der Wärmepumpe.</li>',
        '<li>Erneute Dichtheitsprüfung der Wärmepumpe vor Ort (Kälteseitig).</li>',
        '<li>Wärmepumpe mit Kältemittel befüllen (R290).</li>',
        '<li>Inbetriebnahme des Systems.</li>',
        '<li>Inbetriebnahmeprotokoll.</li>',
        '<li>Instruktion des Systems.</li>',
        '<li>Low-Noise Ausführung</li>',
        '</ul>',
        '<p><strong>Regelung:</strong></p>',
        '<ul>',
        '<li>Regelung Verdampferpumpe.</li>',
        '<li>Regelung Verflüssigerpumpe.</li>',
        '<li>Regelung Hochhaltung.</li>',
        '<li>Regelung Sturmlüftung OffiTec integriert.</li>',
        '<li>0-10V Sollwertvorgabe.</li>',
        '<li>Start/Stopp Signal GA.</li>',
        '<li>Betriebssignal.</li>',
        '<li>Sammelalarm.</li>',
        '<li>Modbus TCP oder RS485 (Kundenwunsch).</li>',
        '<li>OffiTec Cloud System (Fernzugriff für Kunde) mit Datenlogger.</li>',
        '<li>12" Touchdisplay Schneider Electric (IPC).</li>',
        '<li>Schneider Electric SPS.</li>',
        '<li>Sprachen: Deutsch, Englisch.</li>',
        '</ul>',
        '<p><strong>Bauseits:</strong></p>',
        '<ul>',
        '<li>Ungehinderter Zugang zu und in den Räumlichkeiten.</li>',
        '<li>Rausführen der Sicherheitsventile.</li>',
        '<li>Ablad/Einbringung der Wärmepumpen.</li>',
        '<li>Elektrische Anschlüsse aller Wärmepumpen.</li>',
        '</ul>'
    ),
    true,
    NOW(3),
    NOW(3)
FROM `Tenant` t;

-- … and a general intro kept available as a second template option.
INSERT INTO `TenderTextTemplate` (`id`, `tenantId`, `title`, `content`, `isDefault`, `createdAt`, `updatedAt`)
SELECT
    UUID(),
    t.`id`,
    'Allgemeine Einleitung',
    CONCAT(
        '<p>Sehr geehrte Damen und Herren</p>',
        '<p>Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen nachfolgend unser Angebot. ',
        'Eine detaillierte Aufstellung der Positionen finden Sie auf den folgenden Seiten.</p>'
    ),
    false,
    NOW(3),
    NOW(3)
FROM `Tenant` t;
