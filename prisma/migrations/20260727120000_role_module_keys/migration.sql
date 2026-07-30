-- Module package per role: subset of module keys whose pages holders of the
-- role can see (null = everything the company's category allows). Roles are
-- tenant-scoped, so each company entity carries its own packages.
ALTER TABLE `Role` ADD COLUMN `moduleKeys` JSON NULL;
