-- ÜRETİM › SATIN ALMA OTOMASYONU (30.09.2026, Vorgabe Samet)
--
-- «Ürün detay kartında üretici kodu, ürün kodu, tedarikçi adı ve tedarikçi
--  maili … her ürünün birim türü … fiyat talepleri artık otomatik gönderiliyor
--  (rfq@offitec.ch) … gelen mailden pdf alınıp direkt tedarikçinin teklifine
--  işleniyor … sipariş gönder dediğimizde hazırlayıp maillerine atıyor.»
--
-- Nur HINZUGEFÜGT (nichts umbenannt, nichts gelöscht) — ein älterer Stand des
-- Servers läuft gegen diese Datenbank unverändert weiter.
--
--   depo_urun_kartlari.productCode      NEU  «Ürün kodu» (steht im PDF, anfangs leer)
--   depo_urun_kartlari.unit             NEU  Einheit der Karte (PCS|M|KG|SET|PACK) → BOM-Zeile
--   depo_urun_kartlari.isDraft          NEU  Taslak: Pflichtangaben fehlen noch
--   depo_urun_tedarikcileri.email       NEU  E-Mail des Lieferanten für diese Karte
--   uretim_bom_siparisleri.documentLanguage  Sprache des Belegs (PDF + Mail)
--   uretim_bom_siparisleri.supplierContact   Ansprechpartner aus dem Angebot (JSON)
--   uretim_posta_kutulari               die Postfächer der Produktion (RFQ / ORDER)
--   uretim_satinalma_postalari          jede verschickte Anfrage/Bestellung (Message-ID!)
--   uretim_satinalma_yanitlari          jede gelesene Antwort eines Lieferanten
--
-- Apply with: npx prisma migrate deploy

-- AlterTable
ALTER TABLE `depo_urun_kartlari`
    ADD COLUMN `productCode` VARCHAR(120) NULL AFTER `modelNumber`,
    ADD COLUMN `unit` VARCHAR(8) NULL AFTER `productCode`,
    ADD COLUMN `isDraft` BOOLEAN NOT NULL DEFAULT false AFTER `serialRequired`;

-- AlterTable
ALTER TABLE `depo_urun_tedarikcileri`
    ADD COLUMN `email` VARCHAR(191) NULL AFTER `barcode`;

-- AlterTable
ALTER TABLE `uretim_bom_siparisleri`
    ADD COLUMN `documentLanguage` VARCHAR(2) NULL AFTER `orderRevision`,
    ADD COLUMN `supplierContact` JSON NULL AFTER `documentLanguage`;

-- CreateTable
CREATE TABLE `uretim_posta_kutulari` (
    `id` VARCHAR(32) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(12) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `fromName` VARCHAR(255) NULL,
    `fromEmail` VARCHAR(255) NOT NULL,
    `smtpHost` VARCHAR(255) NULL,
    `smtpPort` INTEGER NOT NULL DEFAULT 465,
    `smtpSecure` BOOLEAN NOT NULL DEFAULT true,
    `smtpUser` VARCHAR(255) NULL,
    `smtpPassword` TEXT NULL,
    `imapHost` VARCHAR(255) NULL,
    `imapPort` INTEGER NOT NULL DEFAULT 993,
    `imapSecure` BOOLEAN NOT NULL DEFAULT true,
    `imapUser` VARCHAR(255) NULL,
    `imapPassword` TEXT NULL,
    `imapFolder` VARCHAR(255) NULL,
    `sentFolder` VARCHAR(255) NULL,
    `saveToSent` BOOLEAN NOT NULL DEFAULT true,
    `imapUidValidity` BIGINT NULL,
    `imapLastUid` BIGINT NULL,
    `imapLastSyncAt` DATETIME(3) NULL,
    `imapLastError` TEXT NULL,
    `imapLastSummary` VARCHAR(255) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uretim_posta_kutulari_tenantId_purpose_key`(`tenantId`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_satinalma_postalari` (
    `id` VARCHAR(32) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `kind` VARCHAR(12) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `trigger` VARCHAR(12) NULL,
    `mailboxId` VARCHAR(32) NULL,
    `fromEmail` VARCHAR(255) NULL,
    `toEmails` TEXT NULL,
    `subject` VARCHAR(255) NULL,
    `messageId` VARCHAR(255) NULL,
    `lang` VARCHAR(2) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `fileRef` VARCHAR(512) NULL,
    `fileName` VARCHAR(255) NULL,
    `fileSize` INTEGER NULL,
    `error` TEXT NULL,
    `sentById` VARCHAR(191) NULL,
    `sentByName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `uretim_satinalma_postalari_tenantId_purchaseOrderId_idx`(`tenantId`, `purchaseOrderId`),
    INDEX `uretim_satinalma_postalari_tenantId_messageId_idx`(`tenantId`, `messageId`),
    INDEX `uretim_satinalma_postalari_tenantId_requestId_idx`(`tenantId`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uretim_satinalma_yanitlari` (
    `id` VARCHAR(32) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `mailboxId` VARCHAR(32) NOT NULL,
    `providerKey` VARCHAR(191) NOT NULL,
    `internetMessageId` VARCHAR(255) NULL,
    `purchaseOrderId` VARCHAR(191) NULL,
    `mailId` VARCHAR(32) NULL,
    `kind` VARCHAR(12) NULL,
    `status` VARCHAR(12) NOT NULL,
    `fromEmail` VARCHAR(255) NULL,
    `fromName` VARCHAR(255) NULL,
    `subject` VARCHAR(255) NULL,
    `receivedAt` DATETIME(3) NULL,
    `fileRef` VARCHAR(512) NULL,
    `fileName` VARCHAR(255) NULL,
    `fileType` VARCHAR(100) NULL,
    `fileSize` INTEGER NULL,
    `facts` JSON NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uretim_satinalma_yanitlari_mailbox_provider_key`(`tenantId`, `mailboxId`, `providerKey`),
    INDEX `uretim_satinalma_yanitlari_tenantId_purchaseOrderId_idx`(`tenantId`, `purchaseOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
