ALTER TABLE `entity_merge` ADD `method` text NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_merge` ADD `confidence` real NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_merge` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `recording` ADD `merged_into_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_entity_merge` (
	`id` text PRIMARY KEY,
	`entity_type` text NOT NULL,
	`from_id` text NOT NULL,
	`into_id` text NOT NULL,
	`decision` text NOT NULL,
	`origin` text NOT NULL,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence` text,
	`author_user_id` text,
	`hlc` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_entity_merge`(`id`, `entity_type`, `from_id`, `into_id`, `decision`, `origin`, `author_user_id`, `hlc`) SELECT `id`, `entity_type`, `from_id`, `into_id`, `decision`, `origin`, `author_user_id`, `hlc` FROM `entity_merge`;--> statement-breakpoint
DROP TABLE `entity_merge`;--> statement-breakpoint
ALTER TABLE `__new_entity_merge` RENAME TO `entity_merge`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `source_match_source_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `source_match_recording_idx`;--> statement-breakpoint
CREATE INDEX `entity_merge_from_idx` ON `entity_merge` (`entity_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `entity_merge_into_idx` ON `entity_merge` (`entity_type`,`into_id`);--> statement-breakpoint
CREATE INDEX `recording_merged_into_idx` ON `recording` (`merged_into_id`);--> statement-breakpoint
DROP TABLE `source_match`;