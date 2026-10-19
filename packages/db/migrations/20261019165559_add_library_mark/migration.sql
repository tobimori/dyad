ALTER TABLE `library_item` ADD `mark` text DEFAULT 'saved' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `rating_favorite_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `rating_seq_idx`;--> statement-breakpoint
DROP TABLE `rating`;--> statement-breakpoint
ALTER TABLE `library_remote_track` DROP COLUMN `seen_at`;--> statement-breakpoint
DELETE FROM `library_item` WHERE `entity_type` = 'release';
