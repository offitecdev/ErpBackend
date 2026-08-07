-- Handover (delivery) reports gain their own photo attachments (user request
-- 2026-08-03): until now the PDF could only borrow field-report images. The new
-- `images` JSON column stores [{ imageData: <base64 data URL>, caption? }]
-- directly on the report, edited from the delivery checklist editor.
--
-- The admin list endpoint intentionally does NOT select this column (same
-- policy as `responses` / `customerSignature` — heavy blobs are detail-only).
--
-- Apply with: npx prisma migrate deploy

ALTER TABLE `DeliveryReport` ADD COLUMN `images` JSON NULL;
