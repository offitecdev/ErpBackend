-- Sipariş ANSCHREIBEN (ön yazı) + yeniden kullanılabilir taslakları.
--
-- 1) `PurchaseOrder.coverLetter` — PDF'in ilk sayfasında pozisyon tablosundan
--    ÖNCE basılan hitap + giriş metni (düz metin, satır sonları korunur).
--    NULL bırakılırsa PDF şablonunun KENDİ standart metni basılır: varsayılan
--    metin belgede yaşar, kayıtta değil.
-- 2) `PurchaseOrderTextTemplate` — tenant genelinde paylaşılan ön yazı
--    taslakları (teklif tarafındaki `TenderTextTemplate` emsali). Kullanıcı
--    kendi metnini kaydeder ve başka siparişlerde tek tıkla uygular; tablo
--    BOŞ başlar (hazır metin yoktur — standart metin PDF şablonundadır).
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `PurchaseOrder`
    ADD COLUMN `coverLetter` TEXT NULL;

CREATE TABLE IF NOT EXISTS `PurchaseOrderTextTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `content` TEXT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `PurchaseOrderTextTemplate_tenantId_idx` ON `PurchaseOrderTextTemplate`(`tenantId`);
