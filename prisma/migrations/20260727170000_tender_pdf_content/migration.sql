-- Optional PDF content blocks for an offer.
--
-- `coverLetter` already existed but was never surfaced: it is the letter placed
-- on its own page directly after the cover page. These add the two blocks that
-- close the document — a note printed after the totals, and an image printed
-- after that note (stored as a data URI, hence LONGTEXT).
--
-- All three are optional; an offer with none of them renders exactly as before.
ALTER TABLE `Tender`
    ADD COLUMN `closingNote` LONGTEXT NULL,
    ADD COLUMN `closingImageUrl` LONGTEXT NULL;
