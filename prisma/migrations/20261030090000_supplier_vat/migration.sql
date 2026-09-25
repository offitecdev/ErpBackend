-- TEDARİKÇİ KDV'Sİ (24.09.2026): NULL = belirtilmedi; true → ülke + oran
-- stok siparişine otomatik aktarılır, false → sipariş KDV'si 0.
ALTER TABLE `Supplier` ADD COLUMN `vatLiable` BOOLEAN NULL,
    ADD COLUMN `vatCountry` VARCHAR(80) NULL,
    ADD COLUMN `vatRate` DOUBLE NULL;
