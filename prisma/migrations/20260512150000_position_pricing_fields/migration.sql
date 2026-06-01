-- Add per-position pricing & image fields
ALTER TABLE `Position`
    ADD COLUMN `imageUrl`  TEXT NULL,
    ADD COLUMN `unitPrice` DOUBLE NULL,
    ADD COLUMN `discount`  DOUBLE NULL DEFAULT 0,
    ADD COLUMN `taxRate`   DOUBLE NULL DEFAULT 0;
