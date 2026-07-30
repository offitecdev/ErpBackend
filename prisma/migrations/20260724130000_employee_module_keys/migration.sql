-- Personal module package per employee: subset of module keys the staff
-- member can see (null = everything the company's category allows).
ALTER TABLE `Employee` ADD COLUMN `moduleKeys` JSON NULL;
