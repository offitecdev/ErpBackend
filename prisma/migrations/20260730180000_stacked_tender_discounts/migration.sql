-- Stacked, named discounts on quote lines and on the quote total.
--
-- Both columns hold a JSON array of {name, kind, value} where `kind` is
-- PERCENT or AMOUNT, applied SEQUENTIALLY (each entry works on what the
-- previous ones left over).
--
-- The existing percentage columns stay and keep driving every price
-- calculation: `Position.discount` is re-derived as the combined percentage of
-- `Position.discounts`, and `Tender.directDiscount` as the combined percentage
-- of `Tender.totalDiscounts` (with `Tender.extraDiscount` forced to 0, since
-- the list supersedes the old two-discount pair). Rows that never get a list
-- keep behaving exactly as before.
-- Run with: npx prisma migrate deploy

ALTER TABLE `Position`
  ADD COLUMN `discounts` TEXT NULL;

ALTER TABLE `Tender`
  ADD COLUMN `totalDiscounts` TEXT NULL;
