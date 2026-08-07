-- Aynı teklifin (sürümler tenderNumber'ı paylaşır) İKİNCİ ve sonraki
-- siparişleri FARKLI bir numara TAŞIMAZ: aynı kod "-2" ("-3", …) ekini alır
-- (kullanıcı isteği 2026-08-06: "ikinci taslağın kodu AU-2026-10046-2 olmalı").
--
-- Çalışma zamanı bunu artık böyle üretiyor (createFromTender); bu geçiş bir
-- önceki geçişin kenara taşıdığı mevcut mükerrerleri kurala çeker:
-- AU-2026-10052 (AN-2026-10046'nın ikinci siparişi) → AU-2026-10046-2.
--
--  ⚠ Sıra oluşturulma tarihine göredir: en eski sipariş çıplak kodu taşır
--    (rk=1, dokunulmaz), ikincisi "-2", üçüncüsü "-3" alır.
--  ⚠ Hedef kod aynı kiracıda zaten doluysa satır ATLANIR; ifade iki kez
--    çalıştırılabilir.
--  ⚠ Değiştirilen kod `legacyNumber`a yalnızca boşsa yazılır (gerçek eski
--    kodlar ezilmez).
--
-- Apply with: npx prisma migrate deploy

UPDATE `SalesOrder` `so`
JOIN `Tender` `t` ON `t`.`id` = `so`.`tenderId`
JOIN (
    SELECT `so2`.`id`, COUNT(*) AS `rk`
    FROM `SalesOrder` `so2`
    JOIN `Tender` `t2` ON `t2`.`id` = `so2`.`tenderId`
    JOIN `Tender` `t3` ON `t3`.`tenderNumber` = `t2`.`tenderNumber`
    JOIN `SalesOrder` `so3` ON `so3`.`tenderId` = `t3`.`id` AND `so3`.`tenantId` = `so2`.`tenantId`
    WHERE `t2`.`tenderNumber` REGEXP '^AN-[0-9]{4}-[0-9]+$'
      AND `so3`.`createdAt` <= `so2`.`createdAt`
    GROUP BY `so2`.`id`
) `r` ON `r`.`id` = `so`.`id`
SET `so`.`legacyNumber` = COALESCE(NULLIF(`so`.`legacyNumber`, ''), `so`.`orderNumber`),
    `so`.`orderNumber` = CONCAT('AU', SUBSTRING(`t`.`tenderNumber`, 3), '-', `r`.`rk`)
WHERE `r`.`rk` >= 2
  AND `t`.`tenderNumber` REGEXP '^AN-[0-9]{4}-[0-9]+$'
  AND `so`.`orderNumber` <> CONCAT('AU', SUBSTRING(`t`.`tenderNumber`, 3), '-', `r`.`rk`)
  AND NOT EXISTS (
      SELECT 1 FROM (SELECT `tenantId`, `orderNumber` FROM `SalesOrder`) `other`
      WHERE `other`.`tenantId` = `so`.`tenantId`
        AND `other`.`orderNumber` = CONCAT('AU', SUBSTRING(`t`.`tenderNumber`, 3), '-', `r`.`rk`)
  );
