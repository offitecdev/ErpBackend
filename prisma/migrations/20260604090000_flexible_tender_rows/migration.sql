ALTER TABLE `Position`
  ADD COLUMN `rowType` VARCHAR(32) NOT NULL DEFAULT 'SECTION',
  ADD COLUMN `sourceArticleId` VARCHAR(191) NULL,
  ADD COLUMN `displayOrder` INTEGER NOT NULL DEFAULT 0;

CREATE INDEX `Position_sourceArticleId_idx` ON `Position`(`sourceArticleId`);
CREATE INDEX `Position_tenderId_parentPositionId_displayOrder_idx` ON `Position`(`tenderId`, `parentPositionId`, `displayOrder`);

ALTER TABLE `PositionArticleMapping` DROP INDEX `PositionArticleMapping_positionId_articleId_key`;
CREATE INDEX `PositionArticleMapping_positionId_idx` ON `PositionArticleMapping`(`positionId`);
CREATE INDEX `PositionArticleMapping_articleId_idx` ON `PositionArticleMapping`(`articleId`);
