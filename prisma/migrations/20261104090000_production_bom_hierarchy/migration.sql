-- BOM-HIERARCHIE (27.09.2026, Vorgabe Samet)
--
-- «Her zaman bir ana BOM olmak zorundadır, bu ana BOM'un altında alt BOM'lar
--  olmalıdır … ana BOM kodu BOM-MEK-00001 / BOM-ELK-00001 … alt BOM kodları
--  ayarlardan Mekanik ve Elektrik için ayrı ayrı belirlenir … illa şablondan
--  eklemek zorunda değiliz, boş BOM da olabilir.»
--
-- Nur HINZUGEFÜGT (und ein Vorgabewert für `templateName`); nichts gelöscht,
-- nichts umbenannt:
--   uretim_bomlari.kind         NEU  MAIN | SUB (bestehende Zeilen: SUB)
--   uretim_bomlari.parentBomId  NEU  Alt-BOM → ihre Haupt-BOM
--   uretim_bomlari.mainKey      NEU  `<Gerät>:<Bereich>` nur bei der Haupt-BOM;
--                                    eindeutig je Firma → genau eine Haupt-BOM
--   uretim_bomlari.templateName      Vorgabe '' (die leere BOM hat keine Vorlage)
--   uretim_bom_ayarlari.codes   NEU  die Alt-BOM-Kodes je Bereich (JSON)
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `uretim_bomlari` ADD COLUMN `kind` VARCHAR(8) NOT NULL DEFAULT 'SUB',
    ADD COLUMN `mainKey` VARCHAR(80) NULL,
    ADD COLUMN `parentBomId` VARCHAR(191) NULL,
    MODIFY `templateName` VARCHAR(160) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE `uretim_bom_ayarlari` ADD COLUMN `codes` JSON NULL;

-- CreateIndex
CREATE INDEX `uretim_bomlari_tenantId_parentBomId_idx` ON `uretim_bomlari`(`tenantId`, `parentBomId`);

-- CreateIndex
CREATE UNIQUE INDEX `uretim_bomlari_tenantId_mainKey_key` ON `uretim_bomlari`(`tenantId`, `mainKey`);
