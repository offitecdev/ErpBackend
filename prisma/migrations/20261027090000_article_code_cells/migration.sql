-- ERP-CODE MIT 2–4 ZELLEN (22.09.2026, Vorgabe Samet)
--
-- Bis hierher war der Code fest zweiteilig: KATEGORIE-UNTERKATEGORIE-NNNNN.
-- Ab jetzt traegt der Nummernkreis in `code` die Zellen NACH der Kategorie,
-- mit Bindestrich verbunden («PANO-PLC-H») — zusammen mit der Kategorie also
-- 2 bis 4 Zellen, die fuenfte ist der Zaehler: ELK-PANO-PLC-H-00400.
-- `digits` sagt, wie breit dieser Zaehler laeuft.
ALTER TABLE `ArticleCodeScheme`
    MODIFY `code` VARCHAR(32) NOT NULL,
    ADD COLUMN `digits` INTEGER NOT NULL DEFAULT 5;

-- Der vorlaeufige Kreis des Wareneingangs (AA-BB) zaehlt sechsstellig; bis
-- jetzt stand das als Sonderfall im Quelltext.
UPDATE `ArticleCodeScheme` `s`
    JOIN `ArticleCodeCategory` `c` ON `c`.`id` = `s`.`categoryId`
    SET `s`.`digits` = 6
    WHERE `c`.`code` = 'AA' AND `s`.`code` = 'BB';
