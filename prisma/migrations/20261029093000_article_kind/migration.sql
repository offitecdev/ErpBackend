-- ÜRÜN TÜRÜ (23.09.2026): MANUFACTURED (Üretilecek), RESALE (Satılacak),
-- SERVICE (Ek Hizmet). NULL = seçilmedi; eski kayıtlar olduğu gibi kalır,
-- ürün/hizmet ayrımı `itemType` sütununda yaşamaya devam eder.
ALTER TABLE `Article` ADD COLUMN `articleKind` VARCHAR(16) NULL;
