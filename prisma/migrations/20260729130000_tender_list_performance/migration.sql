-- Teklif listesi tenant içinde filtreleyip sıralıyor. Tek kolonluk
-- `Tender_tenantId` indeksi sıralamayı karşılamadığı için MySQL tenant'ın tüm
-- satırlarını okuyup filesort yapıyordu; bileşik indeksler LIMIT'li sayfayı
-- doğrudan indeks sırasından döndürür.

-- Varsayılan sıralama: WHERE tenantId = ? ORDER BY createdAt DESC LIMIT ?
CREATE INDEX `Tender_tenantId_createdAt_idx`
    ON `Tender`(`tenantId`, `createdAt`);

-- Teklif numarasına göre sıralama / kolon filtresi.
CREATE INDEX `Tender_tenantId_tenderNumber_idx`
    ON `Tender`(`tenantId`, `tenderNumber`);
