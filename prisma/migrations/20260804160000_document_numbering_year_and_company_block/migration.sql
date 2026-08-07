-- BELGE KODU BİÇİM DEĞİŞİKLİĞİ — ÖNEK-NNNNNN  →  ÖNEK-YIL-NNNNN
--
--   AN-000001  →  AN-2026-10001
--   PR-000001  →  PR-2026-10001
--   AU-000001  →  AU-2026-10001
--   NT-000001  →  NT-2026-10001
--   RE-000001  →  RE-2026-10001
--
-- 20260804140000_unified_document_numbering ZATEN UYGULANDI (2026-08-04 11:24)
-- ve veritabanını ÖNEK-NNNNNN biçimine geçirdi. Bu geçiş onun üstüne biner:
-- kodun sayısal kısmı KORUNUR, başına yıl, önüne de şirketin bloğu eklenir.
-- Kayıtların sırası ve birbirine göre konumu DEĞİŞMEZ.
--
-- ── Şirket bloğu ─────────────────────────────────────────────────────────────
-- Blok = `ModuleProfile.profileNumber × 10000` (şirket kategorisi,
-- /settings/company-categories altında seçilir). Kategori 1 olan şirketin
-- AN-000051'i AN-2026-10051 olur; kategorisi olmayan şirket blok 0'da kalır ve
-- yalnızca yıl kazanır (AN-000003 → AN-2026-00003).
--
-- ── Yıl ──────────────────────────────────────────────────────────────────────
-- Yıl kaydın kendi `createdAt` yılıdır ve yalnızca ETİKETTİR; sayaç yıl başında
-- SIFIRLANMAZ (…-2026-10051 → …-2027-10052).
--
-- ⚠ TEKRAR ÇALIŞTIRILABİLİR: her UPDATE yalnızca "ÖNEK-rakamlar" kalıbındaki
-- kodlara dokunur. Dönüşmüş kod iki tire taşıdığı için kalıba uymaz, yani ikinci
-- çalıştırma hiçbir satırı ikinci kez çeviremez.
--
-- ⚠ `legacyNumber` KORUNUR: gerçek özgün kodlar (TKF-2026-2595, INV-2026-0001,
-- SPR-T-2026-3156) orada duruyor ve üzerine YAZILMAZ. Yalnızca 14:00 geçişinden
-- SONRA açılıp legacyNumber'ı boş kalan kayıtlara o anki kodları yazılır, böylece
-- ÖNEK-NNNNNN biçimini görmüş bağlantılar da çözülmeye devam eder.
--
-- Uygulama: npx prisma migrate deploy

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) 14:00 geçişinden sonra açılan kayıtların o anki kodunu sakla
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `Tender`     SET `legacyNumber` = `tenderNumber`  WHERE `legacyNumber` IS NULL;
UPDATE `SalesOrder` SET `legacyNumber` = `orderNumber`   WHERE `legacyNumber` IS NULL;
UPDATE `Invoice`    SET `legacyNumber` = `invoiceNumber` WHERE `legacyNumber` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Adı teklif kodundan TÜRETİLMİŞ projeleri işaretle
--
-- Uygulanan geçiş, proje adının içindeki eski teklif kodunu yeni teklif koduyla
-- değiştirmişti; bu yüzden bugün projeler "AN-000001" gibi TEKLİF kodu taşıyor.
-- Kural ise projenin ADI KENDİ KODUDUR. İşaretleme kodlar çevrilmeden ÖNCE
-- yapılır (eşleşme mevcut değerlere göre), yazma ise çevrildikten SONRA.
--
-- ⚠ Yalnızca türetilmiş adlar işaretlenir: elle yazılmış bir ad ("Heizung Umbau
-- Muster AG") ne teklif koduna eşittir ne de eski kodu içerir — dokunulmaz.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE `_ProjectNameFix` (
    `projectId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`projectId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_ProjectNameFix` (`projectId`)
SELECT `p`.`id`
FROM `Project` `p`
JOIN `Tender` `t` ON `t`.`id` = `p`.`tenderId`
WHERE `p`.`projectName` = `t`.`tenderNumber`
   OR `p`.`projectName` = `p`.`projectNumber`
   OR (
        `t`.`legacyNumber` IS NOT NULL
    AND `t`.`legacyNumber` <> ''
    AND `p`.`projectName` LIKE CONCAT('%', `t`.`legacyNumber`, '%')
   );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Kodları çevir — sayısal kısım korunur, blok eklenir, başa yıl yazılır
--
-- `SUBSTRING_INDEX(code, '-', -1)` son tireden sonrasını verir; kalıp filtresi
-- (REGEXP) sayesinde bu her zaman saf rakamdır. Aynı kolonun hem okunup hem
-- yazılması güvenlidir: MySQL sağ tarafı satırın GÜNCELLENMEMİŞ değeriyle
-- hesaplar ve her satıra tek geçişte dokunur.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `Tender` `x`
JOIN `Tenant` `tn` ON `tn`.`id` = `x`.`tenantId`
LEFT JOIN `ModuleProfile` `mp` ON `mp`.`id` = `tn`.`moduleProfileId`
SET `x`.`tenderNumber` = CONCAT(
        'AN-', YEAR(`x`.`createdAt`), '-',
        LPAD(COALESCE(`mp`.`profileNumber`, 0) * 10000
             + CAST(SUBSTRING_INDEX(`x`.`tenderNumber`, '-', -1) AS UNSIGNED), 5, '0'))
WHERE `x`.`tenderNumber` REGEXP '^[A-Z]{2}-[0-9]+$';

UPDATE `Project` `x`
JOIN `Tenant` `tn` ON `tn`.`id` = `x`.`tenantId`
LEFT JOIN `ModuleProfile` `mp` ON `mp`.`id` = `tn`.`moduleProfileId`
SET `x`.`projectNumber` = CONCAT(
        'PR-', YEAR(`x`.`createdAt`), '-',
        LPAD(COALESCE(`mp`.`profileNumber`, 0) * 10000
             + CAST(SUBSTRING_INDEX(`x`.`projectNumber`, '-', -1) AS UNSIGNED), 5, '0'))
WHERE `x`.`projectNumber` REGEXP '^[A-Z]{2}-[0-9]+$';

-- Ana sipariş (AU-) ve ek sipariş (NT-) aynı tabloda; önek korunur.
UPDATE `SalesOrder` `x`
JOIN `Tenant` `tn` ON `tn`.`id` = `x`.`tenantId`
LEFT JOIN `ModuleProfile` `mp` ON `mp`.`id` = `tn`.`moduleProfileId`
SET `x`.`orderNumber` = CONCAT(
        SUBSTRING_INDEX(`x`.`orderNumber`, '-', 1), '-', YEAR(`x`.`createdAt`), '-',
        LPAD(COALESCE(`mp`.`profileNumber`, 0) * 10000
             + CAST(SUBSTRING_INDEX(`x`.`orderNumber`, '-', -1) AS UNSIGNED), 5, '0'))
WHERE `x`.`orderNumber` REGEXP '^[A-Z]{2}-[0-9]+$';

UPDATE `Invoice` `x`
JOIN `Tenant` `tn` ON `tn`.`id` = `x`.`tenantId`
LEFT JOIN `ModuleProfile` `mp` ON `mp`.`id` = `tn`.`moduleProfileId`
SET `x`.`invoiceNumber` = CONCAT(
        'RE-', YEAR(`x`.`createdAt`), '-',
        LPAD(COALESCE(`mp`.`profileNumber`, 0) * 10000
             + CAST(SUBSTRING_INDEX(`x`.`invoiceNumber`, '-', -1) AS UNSIGNED), 5, '0'))
WHERE `x`.`invoiceNumber` REGEXP '^[A-Z]{2}-[0-9]+$';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) İşaretli projelerin adını kendi (yeni) koduna eşitle
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `Project` `p`
JOIN `_ProjectNameFix` `f` ON `f`.`projectId` = `p`.`id`
SET `p`.`projectName` = `p`.`projectNumber`;

DROP TABLE `_ProjectNameFix`;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Sayaçları da bloğa taşı
--
-- Sayaç MUTLAK sırayı tutar; kodlar bloğa taşındığına göre sayaç da taşınmalı,
-- yoksa bir sonraki belge blok dışından bir numara alırdı.
--
-- ⚠ Koşul aynı zamanda tekrar-çalıştırma korumasıdır: zaten bloğun içinde olan
-- bir sayaç (10051 ≥ 10001) ikinci kez taşınmaz. Bloksuz (kategori 0) şirkette
-- toplanacak bir şey olmadığı için satır zaten atlanır.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE `DocumentCounter` `dc`
JOIN `Tenant` `tn` ON `tn`.`id` = `dc`.`tenantId`
LEFT JOIN `ModuleProfile` `mp` ON `mp`.`id` = `tn`.`moduleProfileId`
SET `dc`.`lastValue` = COALESCE(`mp`.`profileNumber`, 0) * 10000 + `dc`.`lastValue`,
    `dc`.`updatedAt` = NOW(3)
WHERE `dc`.`lastValue` < COALESCE(`mp`.`profileNumber`, 0) * 10000 + 1;
