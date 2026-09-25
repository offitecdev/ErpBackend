-- ŞİRKET TÜRÜ (23.09.2026): A = PRODUCTION (Üretim), B = PROJECT (Proje),
-- C = SALES (Satış). NULL = henüz seçilmedi — mevcut şirketler seçilene kadar
-- eskisi gibi çalışır (yeni ürün formunda yalnızca ürün adı zorunludur).
ALTER TABLE `Tenant` ADD COLUMN `companyType` VARCHAR(16) NULL;
