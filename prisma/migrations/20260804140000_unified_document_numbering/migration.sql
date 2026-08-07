-- BİRLEŞİK BELGE NUMARALANDIRMA — ÖNEK-000001, her dilde aynı, artan sayaç.
--
--   Teklif      Angebot   → AN-000001   (eskiden A-2026-4474 / TKF-… , frontend'de rastgele)
--   Proje       Projekt   → PR-000001   (eskiden kod YOKTU)
--   Sipariş     Auftrag   → AU-000001   (eskiden AUF-<teklif kodu> / SO-<teklif kodu>)
--   Ek sipariş  Nachtrag  → NT-000001   (eskiden <üst sipariş kodu>-N1)
--   Fatura      Rechnung  → RE-000001   (eskiden INV-2026-0001)
--
-- Sıra TENANT BAŞINA verilir: her şirket kendi AN-000001'inden başlar.
-- Numaralar `createdAt` sırasına göre dağıtılır, yani en eski belge en küçük
-- numarayı alır ve kayıtların kronolojik sırası korunur.
--
-- ⚠ ESKİ KOD KAYBOLMAZ: her tabloya `legacyNumber` eklenir ve eski değer oraya
-- taşınır. Eski koda göre arama/bağlantı çözümü bu kolon üzerinden çalışmaya
-- devam eder (main.ts findTenderForTenant, TenderController resolve-by-number,
-- liste arama filtreleri).
--
-- ⚠ MÜŞTERİYE GÖNDERİLMİŞ PDF'ler ESKİ KODU TAŞIR. Bu geçiş yalnızca kaydı
-- yeniden numaralar; daha önce e-postayla gitmiş bir teklif/fatura PDF'i
-- sistemdeki koddan farklı görünecektir. Eşleştirme `legacyNumber` ile yapılır.
--
-- ⚠ Bir teklifin TÜM SÜRÜMLERİ (version 1,2,3…) aynı AN- kodunu paylaşır:
-- gruplama (tenantId, eski tenderNumber) üzerinden yapılır, sıra ise o grubun
-- EN ESKİ kaydının tarihine göre belirlenir.
--
-- ⚠ Satın alma siparişleri (PurchaseOrder) BU GEÇİŞİN DIŞINDADIR; BE-{yıl}-{sıra}
-- biçimini korurlar (bkz. 20260803160000_purchase_order_renumber_au_to_be).
--
-- MySQL 5.7 + 8.x uyumlu: pencere fonksiyonu (ROW_NUMBER) ve UPDATE içinde
-- oturum değişkeni (@rn := …) KULLANILMAZ; sıra, AUTO_INCREMENT'li geçici bir
-- eşleme tablosu üzerinden hesaplanır.
--
-- Uygulama: npx prisma migrate deploy

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Sayaç tablosu ve yeni kolonlar
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE `DocumentCounter` (
    `tenantId`  VARCHAR(191) NOT NULL,
    `docType`   VARCHAR(32)  NOT NULL,
    `lastValue` INT          NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3)  NOT NULL,
    PRIMARY KEY (`tenantId`, `docType`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Tender`     ADD COLUMN `legacyNumber`  VARCHAR(191) NULL;
ALTER TABLE `SalesOrder` ADD COLUMN `legacyNumber`  VARCHAR(191) NULL;
ALTER TABLE `Invoice`    ADD COLUMN `legacyNumber`  VARCHAR(191) NULL;
-- Proje kodu önce NULL kabul eder; satırlar dolduktan sonra NOT NULL'a çekilir.
ALTER TABLE `Project`    ADD COLUMN `projectNumber` VARCHAR(191) NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Eski kodu sakla (tek tablo UPDATE'i — join yok, güvenli ve tekrar edilebilir)
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `Tender`     SET `legacyNumber` = `tenderNumber`  WHERE `legacyNumber` IS NULL;
UPDATE `SalesOrder` SET `legacyNumber` = `orderNumber`   WHERE `legacyNumber` IS NULL;
UPDATE `Invoice`    SET `legacyNumber` = `invoiceNumber` WHERE `legacyNumber` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Sıra eşlemesi
--
-- `seq` AUTO_INCREMENT olduğu için satırlar ekleme sırasında numaralanır; her
-- INSERT ... SELECT bir ORDER BY ile beslenir. `seq` GLOBAL bir sıradır; tenant
-- içi sıra (`rn`) 4. adımda ondan türetilir.
--
-- Geçici (TEMPORARY) tablo KULLANILMAZ: MySQL geçici bir tabloyu aynı sorguda
-- iki kez açamaz, 4. adımdaki self-join buna ihtiyaç duyar.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE `_DocumentRenumberMap` (
    `seq`      INT          NOT NULL AUTO_INCREMENT,
    `docType`  VARCHAR(32)  NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    -- QUOTE için eski teklif kodu (sürümler ortak), diğerlerinde kaydın id'si.
    `groupKey` VARCHAR(191) NOT NULL,
    `rn`       INT          NULL,
    PRIMARY KEY (`seq`),
    KEY `scope` (`docType`, `tenantId`, `seq`),
    KEY `lookup` (`docType`, `tenantId`, `groupKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Teklif: sürümler tek koda düşsün diye (tenantId, eski kod) gruplanır.
INSERT INTO `_DocumentRenumberMap` (`docType`, `tenantId`, `groupKey`)
SELECT 'QUOTE', `tenantId`, `legacyNumber`
FROM `Tender`
WHERE `legacyNumber` IS NOT NULL
GROUP BY `tenantId`, `legacyNumber`
ORDER BY `tenantId`, MIN(`createdAt`), `legacyNumber`;

INSERT INTO `_DocumentRenumberMap` (`docType`, `tenantId`, `groupKey`)
SELECT 'PROJECT', `tenantId`, `id`
FROM `Project`
ORDER BY `tenantId`, `createdAt`, `id`;

-- Ana sipariş: üst siparişi olmayan ve türü PROJECT_ADDON olmayanlar.
INSERT INTO `_DocumentRenumberMap` (`docType`, `tenantId`, `groupKey`)
SELECT 'ORDER', `tenantId`, `id`
FROM `SalesOrder`
WHERE `parentSalesOrderId` IS NULL AND `orderType` <> 'PROJECT_ADDON'
ORDER BY `tenantId`, `createdAt`, `id`;

-- Ek sipariş (Nachtrag): üst siparişi olan ya da türü PROJECT_ADDON olanlar.
INSERT INTO `_DocumentRenumberMap` (`docType`, `tenantId`, `groupKey`)
SELECT 'ADDON', `tenantId`, `id`
FROM `SalesOrder`
WHERE `parentSalesOrderId` IS NOT NULL OR `orderType` = 'PROJECT_ADDON'
ORDER BY `tenantId`, `createdAt`, `id`;

INSERT INTO `_DocumentRenumberMap` (`docType`, `tenantId`, `groupKey`)
SELECT 'INVOICE', `tenantId`, `id`
FROM `Invoice`
ORDER BY `tenantId`, `createdAt`, `id`;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Global `seq` → tenant içi sıra `rn` (her (docType, tenantId) 1'den başlar)
--
-- ⚠ Bu self-join, tenant içindeki belge sayısına göre KARESEL çalışır (bir
-- tenantta N teklif varsa ~N²/2 satır karşılaştırması). Birkaç bin kayıtta
-- saniyeler sürer; on binlerce kayıtlı bir tenant varsa geçiş uzayabilir.
-- MySQL 8 kullanıldığı KESİNSE bu blok tek bir pencere fonksiyonuyla
-- değiştirilebilir:
--     UPDATE `_DocumentRenumberMap` `m` JOIN (
--         SELECT `seq`, ROW_NUMBER() OVER (
--             PARTITION BY `docType`, `tenantId` ORDER BY `seq`
--         ) AS `rn` FROM `_DocumentRenumberMap`
--     ) `x` ON `x`.`seq` = `m`.`seq` SET `m`.`rn` = `x`.`rn`;
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `_DocumentRenumberMap` `m`
JOIN (
    SELECT `a`.`seq` AS `s`, COUNT(*) AS `rn`
    FROM `_DocumentRenumberMap` `a`
    JOIN `_DocumentRenumberMap` `b`
      ON `b`.`docType`  = `a`.`docType`
     AND `b`.`tenantId` = `a`.`tenantId`
     AND `b`.`seq`     <= `a`.`seq`
    GROUP BY `a`.`seq`
) `x` ON `x`.`s` = `m`.`seq`
SET `m`.`rn` = `x`.`rn`;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Kodları yaz
--
-- Join anahtarı HER ZAMAN yazılmayan bir kolondur (`legacyNumber` ya da `id`),
-- böylece UPDATE kendi join'ini bozamaz.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `Tender` `t`
JOIN `_DocumentRenumberMap` `m`
  ON `m`.`docType`  = 'QUOTE'
 AND `m`.`tenantId` = `t`.`tenantId`
 AND `m`.`groupKey` = `t`.`legacyNumber`
SET `t`.`tenderNumber` = CONCAT('AN-', LPAD(`m`.`rn`, 6, '0'));

UPDATE `Project` `p`
JOIN `_DocumentRenumberMap` `m`
  ON `m`.`docType`  = 'PROJECT'
 AND `m`.`tenantId` = `p`.`tenantId`
 AND `m`.`groupKey` = `p`.`id`
SET `p`.`projectNumber` = CONCAT('PR-', LPAD(`m`.`rn`, 6, '0'));

UPDATE `SalesOrder` `s`
JOIN `_DocumentRenumberMap` `m`
  ON `m`.`docType`  = 'ORDER'
 AND `m`.`tenantId` = `s`.`tenantId`
 AND `m`.`groupKey` = `s`.`id`
SET `s`.`orderNumber` = CONCAT('AU-', LPAD(`m`.`rn`, 6, '0'));

UPDATE `SalesOrder` `s`
JOIN `_DocumentRenumberMap` `m`
  ON `m`.`docType`  = 'ADDON'
 AND `m`.`tenantId` = `s`.`tenantId`
 AND `m`.`groupKey` = `s`.`id`
SET `s`.`orderNumber` = CONCAT('NT-', LPAD(`m`.`rn`, 6, '0'));

UPDATE `Invoice` `i`
JOIN `_DocumentRenumberMap` `m`
  ON `m`.`docType`  = 'INVOICE'
 AND `m`.`tenantId` = `i`.`tenantId`
 AND `m`.`groupKey` = `i`.`id`
SET `i`.`invoiceNumber` = CONCAT('RE-', LPAD(`m`.`rn`, 6, '0'));

-- Emniyet: eşlemeye giremeyen (ör. tenantId'si boş) bir proje kalırsa kod
-- üretemeyiz ama NOT NULL kısıtı da kaydı düşürmemeli — id'den türetilmiş bir
-- yer tutucu verilir ve elle düzeltilebilir.
UPDATE `Project` SET `projectNumber` = CONCAT('PR-X-', `id`) WHERE `projectNumber` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Serbest metne gömülü eski teklif kodlarını da güncelle
--
-- Proje adları çoğunlukla teklif kodundan doğuyordu ("TKF-2026-3684 - Montaj").
-- Frontend bunları arayüz diline göre yeniden yazıyordu (localizeTenderNumbersInText);
-- o davranış kaldırıldığı için kodun metnin İÇİNDE de güncel olması gerekir.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `Project` `p`
JOIN `Tender` `t` ON `t`.`id` = `p`.`tenderId`
SET `p`.`projectName` = REPLACE(`p`.`projectName`, `t`.`legacyNumber`, `t`.`tenderNumber`)
WHERE `t`.`legacyNumber` IS NOT NULL
  AND `t`.`legacyNumber` <> ''
  AND `p`.`projectName` LIKE CONCAT('%', `t`.`legacyNumber`, '%');

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Sayaçları dağıtılmış en büyük sıradan başlat
--
-- Bir sonraki belge `lastValue + 1` alır, yani mevcut serinin hemen ardından
-- gelir; daha önce görülmüş bir numara ikinci kez dağıtılmaz.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `DocumentCounter` (`tenantId`, `docType`, `lastValue`, `updatedAt`)
SELECT `tenantId`, `docType`, MAX(`rn`), NOW(3)
FROM `_DocumentRenumberMap`
WHERE `rn` IS NOT NULL
GROUP BY `tenantId`, `docType`;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) Kısıtlar, indeksler, temizlik
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `Project` MODIFY `projectNumber` VARCHAR(191) NOT NULL;

CREATE INDEX `Tender_tenantId_legacyNumber_idx`      ON `Tender`(`tenantId`, `legacyNumber`);
CREATE INDEX `SalesOrder_tenantId_orderNumber_idx`   ON `SalesOrder`(`tenantId`, `orderNumber`);
CREATE INDEX `SalesOrder_tenantId_legacyNumber_idx`  ON `SalesOrder`(`tenantId`, `legacyNumber`);
CREATE INDEX `Invoice_tenantId_invoiceNumber_idx`    ON `Invoice`(`tenantId`, `invoiceNumber`);
CREATE INDEX `Invoice_tenantId_legacyNumber_idx`     ON `Invoice`(`tenantId`, `legacyNumber`);
CREATE INDEX `Project_tenantId_projectNumber_idx`    ON `Project`(`tenantId`, `projectNumber`);

DROP TABLE `_DocumentRenumberMap`;
