-- Business date for a sales order, shown to the user. For addon (Zusatzauftrag)
-- orders this holds the original appointment date the extra work belongs to, which
-- can predate `createdAt` when an expense/material is entered days after the montage.
-- `createdAt` remains the internal "unbilled since last addon" slice boundary;
-- `orderDate` is display-only and falls back to `createdAt` when NULL.
ALTER TABLE `SalesOrder`
    ADD COLUMN `orderDate` DATETIME(3) NULL;
