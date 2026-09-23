-- HER AŞAMANIN KENDİ BELGESİ (Samet, 21.09.2026).
--
-- «Birleştirme satırların alt alta birleşmesi değil — fiyat talebi ayrı,
-- sipariş ayrı olacak. Sipariş iptal edilirse ve fiyat onaylanırsa, o zaman
-- direkt fiyatın verileri gelecek.»
--
-- Bir süreç üç belge taşıyabilir: fiyat talebi (1), sipariş (2), mal kabul (3).
-- Her birinin KENDİ satırları, ek ücretleri ve toplamları vardır; `items` ve
-- `total*` kolonları her zaman GÜNCEL aşamanın kopyasıdır, böylece uygulamanın
-- geri kalanı (PDF, mail, üretim bağı) aynı alanları okumaya devam eder.
-- NULL = tek aşama yaşamış eski kayıt; ilk aşama değişiminde kendiliğinden dolar.
ALTER TABLE `PurchaseOrder`
    ADD COLUMN `stageDocuments` LONGTEXT NULL AFTER `orderNumber`;
