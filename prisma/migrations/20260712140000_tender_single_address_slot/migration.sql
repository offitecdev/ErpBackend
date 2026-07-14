-- The quote now carries ONE project/delivery address: either installationAddress
-- (Projektadresse) or deliveryAddress (Lieferadresse), never both. The earlier
-- split migration copied deliveryAddress into installationAddress for legacy
-- tenders — clear the duplicated delivery side so exactly one field is set.
UPDATE `Tender`
SET `deliveryAddress` = NULL
WHERE `deliveryAddress` IS NOT NULL
  AND `installationAddress` IS NOT NULL
  AND `deliveryAddress` = `installationAddress`;
