-- Müşteri listesi her zaman tenant içinde filtreleyip sıralıyor. Tek kolonluk
-- `Customer_tenantId_fkey` indeksi sıralamayı karşılamadığı için MySQL tenant'ın
-- tüm satırlarını okuyup filesort yapıyordu; bileşik indeksler LIMIT'li sayfayı
-- doğrudan indeks sırasından döndürür.

-- Varsayılan sıralama: WHERE tenantId = ? ORDER BY companyName LIMIT ?
CREATE INDEX `Customer_tenantId_companyName_idx`
    ON `Customer`(`tenantId`, `companyName`);

-- Durum filtresi + ada göre sıralama (üst çubuktaki durum seçici).
CREATE INDEX `Customer_tenantId_status_companyName_idx`
    ON `Customer`(`tenantId`, `status`, `companyName`);

-- VAT kolonuna göre sıralama.
CREATE INDEX `Customer_tenantId_vatNumber_idx`
    ON `Customer`(`tenantId`, `vatNumber`);
