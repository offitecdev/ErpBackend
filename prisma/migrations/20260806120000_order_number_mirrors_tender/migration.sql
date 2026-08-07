-- Sipariş kodu teklifin kodunu AYNEN izler (kullanıcı isteği 2026-08-06:
-- "AU-2026-10009 ile AN-2026-10028 böyle olamaz; eşit olmalı").
--
-- Çalışma zamanı artık yeni siparişleri teklifin yıl+sırasıyla üretiyor
-- (SalesOrderController.createFromTender → parseDocumentNumber); bu geçiş
-- MEVCUT siparişleri aynı kurala çeker: AN-2026-10028'in siparişi
-- AU-2026-10028 olur — yalnızca önek değişir, yıl ve sıra tekliften kopyalanır.
--
-- Neden aşamalı (gerçek yardımcı tablolar + '~' ara kodu):
--  ⚠ Hedef kodlar mevcut kodlarla ZİNCİR kurar (10003→10006, 10006→10020 …).
--    Tek UPDATE anlık görüntüye baktığı için zincir hiç çözülmezdi; önce tüm
--    taşınacak satırlar '~' ara koduna alınır, eski kodlar boşalır, sonra
--    nihai kodlar yazılır.
--  ⚠ Bir teklifin TÜM sürümleri aynı tenderNumber'ı paylaşır; koda yalnızca
--    EN ESKİ sipariş geçer. İkinci kez çevrilmiş sürümün siparişi ("mükerrer")
--    sayaç kodunu korur — AMA kodu bir hedefe denk geliyorsa (AU-2026-10014
--    vakası) tenant'ın en yüksek AU sırasının ÜSTÜNE taşınır ki hedefi
--    kapatmasın.
--  ⚠ Değiştirilen kod `legacyNumber`a yazılır (yalnızca boşsa — birleşik
--    numaralandırma geçişinin sakladığı GERÇEK eski kod ezilmez), aramalar
--    eski kodla bulmayı sürdürür. Müşteriye çoktan e-postalanmış PDF'ler
--    ESKİ kodu taşır; bu yalnızca kaydı yeniden yazar.
--  ⚠ MySQL, TEMPORARY tabloyu aynı sorguda iki kez açamadığı için ("Can't
--    reopen table") yardımcı tablolar GERÇEK tablodur ve sonda silinir.
--
-- Apply with: npx prisma migrate deploy

DROP TABLE IF EXISTS `_om_movers`;
DROP TABLE IF EXISTS `_om_displaced`;
DROP TABLE IF EXISTS `_om_maxseq`;

-- Taşınacaklar: çözümlenebilir (AN-YYYY-NNNNN) teklif kodu başına EN ESKİ
-- sipariş; kodu zaten eşit olan satır listeye girmez.
CREATE TABLE `_om_movers` AS
SELECT `so`.`id`, `so`.`tenantId`, `so`.`orderNumber` AS `oldNumber`,
       CONCAT('AU', SUBSTRING(`t`.`tenderNumber`, 3)) AS `newNumber`,
       CAST(SUBSTRING_INDEX(`t`.`tenderNumber`, '-', -1) AS UNSIGNED) AS `seq`
FROM `SalesOrder` `so`
JOIN `Tender` `t` ON `t`.`id` = `so`.`tenderId`
JOIN (
    SELECT `so2`.`tenantId`, `t2`.`tenderNumber`, MIN(`so2`.`createdAt`) AS `firstCreatedAt`
    FROM `SalesOrder` `so2`
    JOIN `Tender` `t2` ON `t2`.`id` = `so2`.`tenderId`
    WHERE `t2`.`tenderNumber` REGEXP '^AN-[0-9]{4}-[0-9]+$'
    GROUP BY `so2`.`tenantId`, `t2`.`tenderNumber`
) `pick`
  ON `pick`.`tenantId` = `so`.`tenantId`
 AND `pick`.`tenderNumber` = `t`.`tenderNumber`
 AND `pick`.`firstCreatedAt` = `so`.`createdAt`
WHERE `t`.`tenderNumber` REGEXP '^AN-[0-9]{4}-[0-9]+$'
  AND `so`.`orderNumber` <> CONCAT('AU', SUBSTRING(`t`.`tenderNumber`, 3));

-- Tenant başına en yüksek AU sırası — mevcut kodlar VE hedef kodlar birlikte;
-- yerinden edilen mükerrerler bunun üstüne dizilir.
CREATE TABLE `_om_maxseq` AS
SELECT `x`.`tenantId`, MAX(`x`.`seq`) AS `maxSeq`
FROM (
    SELECT `tenantId`, CAST(SUBSTRING_INDEX(`orderNumber`, '-', -1) AS UNSIGNED) AS `seq`
    FROM `SalesOrder`
    WHERE `orderNumber` REGEXP '^AU-[0-9]{4}-[0-9]+$'
    UNION ALL
    SELECT `tenantId`, `seq` FROM `_om_movers`
) `x`
GROUP BY `x`.`tenantId`;

-- Bir hedef kodun üstünde oturan, kendisi TAŞINMAYAN satırlar (mükerrer
-- sürüm siparişleri). `rk` = tenant içindeki sırası (1'den başlar).
CREATE TABLE `_om_displaced` AS
SELECT `so`.`id`, `so`.`tenantId`,
       (
           SELECT COUNT(*)
           FROM `SalesOrder` `so3`
           JOIN `_om_movers` `m3`
             ON `m3`.`tenantId` = `so3`.`tenantId`
            AND `m3`.`newNumber` = `so3`.`orderNumber`
           WHERE `so3`.`tenantId` = `so`.`tenantId`
             AND `so3`.`id` <= `so`.`id`
             AND NOT EXISTS (SELECT 1 FROM `_om_movers` `mm` WHERE `mm`.`id` = `so3`.`id`)
       ) AS `rk`
FROM `SalesOrder` `so`
JOIN `_om_movers` `m`
  ON `m`.`tenantId` = `so`.`tenantId`
 AND `m`.`newNumber` = `so`.`orderNumber`
WHERE NOT EXISTS (SELECT 1 FROM `_om_movers` `self` WHERE `self`.`id` = `so`.`id`);

-- (1) Mükerrerler hedeflerin yolundan çekilir: en yüksek AU sırasının üstü.
UPDATE `SalesOrder` `so`
JOIN `_om_displaced` `d` ON `d`.`id` = `so`.`id`
JOIN `_om_maxseq` `mx` ON `mx`.`tenantId` = `so`.`tenantId`
SET `so`.`legacyNumber` = COALESCE(NULLIF(`so`.`legacyNumber`, ''), `so`.`orderNumber`),
    `so`.`orderNumber` = CONCAT('AU-', YEAR(NOW()), '-', LPAD(`mx`.`maxSeq` + `d`.`rk`, 5, '0'));

-- (2) Taşınacaklar önce '~' ara koduna — eski kodlar boşalır, zincir kalmaz.
UPDATE `SalesOrder` `so`
JOIN `_om_movers` `m` ON `m`.`id` = `so`.`id`
SET `so`.`legacyNumber` = COALESCE(NULLIF(`so`.`legacyNumber`, ''), `so`.`orderNumber`),
    `so`.`orderNumber` = CONCAT('~', `m`.`newNumber`);

-- (3) Nihai kodlar: teklifin yıl+sırası, AU önekiyle.
UPDATE `SalesOrder` `so`
JOIN `_om_movers` `m` ON `m`.`id` = `so`.`id`
SET `so`.`orderNumber` = `m`.`newNumber`
WHERE `so`.`orderNumber` = CONCAT('~', `m`.`newNumber`);

-- (4) AU sayacının tabanı en yüksek AU sırasına çekilir: sayaçtan üretilecek
-- bir sonraki (yedek) kod, tekliften türetilmiş bir kodu ikinci kez dağıtamaz.
-- Satırı olmayan kiracı için satır AÇILIR.
INSERT INTO `DocumentCounter` (`tenantId`, `docType`, `lastValue`, `updatedAt`)
SELECT `m`.`tenantId`, 'ORDER', `m`.`maxSeq`, NOW(3)
FROM (
    SELECT `so`.`tenantId`, MAX(CAST(SUBSTRING_INDEX(`so`.`orderNumber`, '-', -1) AS UNSIGNED)) AS `maxSeq`
    FROM `SalesOrder` `so`
    WHERE `so`.`orderNumber` REGEXP '^AU-[0-9]{4}-[0-9]+$'
    GROUP BY `so`.`tenantId`
) `m`
ON DUPLICATE KEY UPDATE
    `lastValue` = GREATEST(`lastValue`, VALUES(`lastValue`)),
    `updatedAt` = NOW(3);

-- (5) AN sayacı da aynı tabana çekilir: gelecekteki bir teklif, yerinden
-- edilmiş bir mükerrerin yeni AU kodunu (örn. 10052) sıra olarak alsaydı,
-- türetilen sipariş kodu yine çakışırdı. Bir teklif numarası atlanır — sayaçta
-- delik zaten olağandır.
INSERT INTO `DocumentCounter` (`tenantId`, `docType`, `lastValue`, `updatedAt`)
SELECT `m`.`tenantId`, 'QUOTE', `m`.`maxSeq`, NOW(3)
FROM (
    SELECT `so`.`tenantId`, MAX(CAST(SUBSTRING_INDEX(`so`.`orderNumber`, '-', -1) AS UNSIGNED)) AS `maxSeq`
    FROM `SalesOrder` `so`
    WHERE `so`.`orderNumber` REGEXP '^AU-[0-9]{4}-[0-9]+$'
    GROUP BY `so`.`tenantId`
) `m`
ON DUPLICATE KEY UPDATE
    `lastValue` = GREATEST(`lastValue`, VALUES(`lastValue`)),
    `updatedAt` = NOW(3);

DROP TABLE IF EXISTS `_om_movers`;
DROP TABLE IF EXISTS `_om_displaced`;
DROP TABLE IF EXISTS `_om_maxseq`;
