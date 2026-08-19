-- MENGENEINHEITEN ALS PFLEGBARE LISTE (19.08.2026).
--
-- Bis hierher war die Einheit eines Artikels ein FREIES TEXTFELD: jede Person
-- tippte, was ihr einfiel ("Stk", "stk", "Stueck", "Adet"), und die Vorgabe fuer
-- Importe stand fest im Code. Vorgabe: die Einheit wird GEWAEHLT -- Stueck,
-- Meter, Kilogramm, Liter, Set, Packung ... -- und eigene Einheiten koennen
-- spaeter in den Einstellungen dazukommen (Einstellungen -> Module -> Lager ->
-- Einheiten).
--
-- `Article.unit` bleibt bewusst ein Text und traegt weiterhin den kurzen Code
-- ("Stk"): so laufen alle bestehenden Belege, PDFs und Importe unveraendert
-- weiter, und die neue Tabelle sagt nur noch, WAS zur Auswahl steht.
--
-- Der Erstbestand (derselbe wie in src/shared/measurementUnits.ts) wird jedem
-- bestehenden Mandanten angelegt; danach wird JEDE Einheit, die heute schon auf
-- einem Artikel steht und nicht dabei ist, als eigene Einheit uebernommen --
-- sonst waere die Einheit eines Altbestands ploetzlich nicht mehr waehlbar.
-- Neu angelegte Mandanten bekommen den Erstbestand beim ersten Aufruf der Liste.
--
-- Apply with: npx prisma migrate deploy

CREATE TABLE `MeasurementUnit` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(24) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MeasurementUnit_tenantId_code_key`(`tenantId`, `code`),
    INDEX `MeasurementUnit_tenantId_isActive_sortOrder_idx`(`tenantId`, `isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Erstbestand je Mandant. Die Kennung ist aus Mandant + Reihenfolge gebaut und
-- damit wiederholbar -- die Migration kann nicht doppelt anlegen.
INSERT IGNORE INTO `MeasurementUnit`
    (`id`, `tenantId`, `code`, `name`, `sortOrder`, `isActive`, `isDefault`, `createdAt`, `updatedAt`)
SELECT
    CONCAT('mu-', LEFT(MD5(CONCAT(t.`id`, '|', s.`code`)), 16)),
    t.`id`, s.`code`, s.`name`, s.`sortOrder`, true, s.`isDefault`, NOW(3), NOW(3)
FROM `Tenant` t
CROSS JOIN (
              SELECT 'Stk'   AS `code`, 'Stück'         AS `name`,  10 AS `sortOrder`, true  AS `isDefault`
    UNION ALL SELECT 'm',             'Meter',                      20, false
    UNION ALL SELECT 'lfm',           'Laufmeter',                  30, false
    UNION ALL SELECT 'm²',            'Quadratmeter',               40, false
    UNION ALL SELECT 'm³',            'Kubikmeter',                 50, false
    UNION ALL SELECT 'mm',            'Millimeter',                 60, false
    UNION ALL SELECT 'cm',            'Zentimeter',                 70, false
    UNION ALL SELECT 'kg',            'Kilogramm',                  80, false
    UNION ALL SELECT 'g',             'Gramm',                      90, false
    UNION ALL SELECT 't',             'Tonne',                     100, false
    UNION ALL SELECT 'l',             'Liter',                     110, false
    UNION ALL SELECT 'ml',            'Milliliter',                120, false
    UNION ALL SELECT 'Set',           'Set',                       130, false
    UNION ALL SELECT 'Pkg',           'Packung',                   140, false
    UNION ALL SELECT 'Ktn',           'Karton',                    150, false
    UNION ALL SELECT 'Pal',           'Palette',                   160, false
    UNION ALL SELECT 'Rolle',         'Rolle',                     170, false
    UNION ALL SELECT 'Paar',          'Paar',                      180, false
    UNION ALL SELECT 'Std',           'Stunde',                    190, false
    UNION ALL SELECT 'Tag',           'Tag',                       200, false
    UNION ALL SELECT 'Psch',          'Pauschal',                  210, false
) s;

-- Was heute schon auf Artikeln steht, aber nicht im Erstbestand ist, wird
-- uebernommen (Name = Zeichen, es gibt ja keinen ausgeschriebenen). Damit
-- bleibt die Einheit jedes Altbestands waehlbar. `INSERT IGNORE`, weil zwei
-- Alteintraege nach dem Kuerzen auf 24 Zeichen zusammenfallen koennen.
INSERT IGNORE INTO `MeasurementUnit`
    (`id`, `tenantId`, `code`, `name`, `sortOrder`, `isActive`, `isDefault`, `createdAt`, `updatedAt`)
SELECT
    CONCAT('mu-', LEFT(MD5(CONCAT(a.`tenantId`, '|', LEFT(TRIM(a.`unit`), 24))), 16)),
    a.`tenantId`,
    LEFT(TRIM(a.`unit`), 24),
    LEFT(TRIM(a.`unit`), 24),
    900,
    true,
    false,
    NOW(3),
    NOW(3)
FROM `Article` a
WHERE TRIM(COALESCE(a.`unit`, '')) <> ''
GROUP BY a.`tenantId`, LEFT(TRIM(a.`unit`), 24);
