-- An offer may close with SEVERAL images, not one.
--
-- `closingImageUrl` held a single data URI. It is replaced by `closingImages`,
-- a JSON array of data URIs, so the document can end with a set of pictures.
-- The old column shipped moments ago and was never populated, so there is
-- nothing to migrate across.
ALTER TABLE `Tender`
    DROP COLUMN `closingImageUrl`,
    ADD COLUMN `closingImages` LONGTEXT NULL;
