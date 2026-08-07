-- Purchase-order status: "AWAITING_CONFIRMATION" removed (user request 2026-08-03
-- — "it says the same thing as the draft anyway").
--
-- `PurchaseOrder.status` is a free string column, so this migration only moves
-- existing rows onto the remaining vocabulary — no schema change is required.
--
-- The price-request side is now two states instead of three:
--   DRAFT         = request draft, not sent to the supplier yet
--   PRICE_REQUEST = price request that HAS been sent (sending a draft's mail
--                   advances it here; it used to land on AWAITING_CONFIRMATION)
--
-- Every AWAITING_CONFIRMATION row is by definition a request whose mail already
-- went out, so it maps onto PRICE_REQUEST — the record stays priceless and still
-- needs the explicit "convert to order" step. Nothing is lost: the send itself
-- is recorded in `emailSentAt` / `emailRecipient`.
--
-- Apply with: npx prisma migrate deploy

UPDATE `PurchaseOrder` SET `status` = 'PRICE_REQUEST' WHERE `status` = 'AWAITING_CONFIRMATION';
