-- Siparişin ALICI ADI ("Empfänger" / z.Hd.) — opsiyonel.
--
-- Sipariş detaylarından girilir ve doluysa PDF'in alıcı bloğunda firma adının
-- ALTINDA tek küçük satır olarak basılır (tedarikçi kaydındaki kişi alanından
-- bağımsızdır: bu, o siparişin gönderileceği kişi/departmandır).
-- Boş bırakılırsa blok bugünkü hâlini korur.
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `PurchaseOrder`
    ADD COLUMN `recipientName` VARCHAR(191) NULL;
