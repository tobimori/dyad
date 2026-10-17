ALTER TABLE `source_segment` ADD `recording_id` text;--> statement-breakpoint
ALTER TABLE `source_segment` ADD `raw_artist` text;--> statement-breakpoint
ALTER TABLE `source_segment` ADD `raw_title` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_source_segment` (
	`source_id` text NOT NULL,
	`position` integer NOT NULL,
	`recording_id` text,
	`raw_artist` text,
	`raw_title` text,
	`start_ms` integer,
	`end_ms` integer,
	CONSTRAINT `source_segment_pk` PRIMARY KEY(`source_id`, `position`)
);
--> statement-breakpoint
INSERT INTO `__new_source_segment`(`source_id`, `position`, `start_ms`, `end_ms`) SELECT `source_id`, `position`, `start_ms`, `end_ms` FROM `source_segment`;--> statement-breakpoint
DROP TABLE `source_segment`;--> statement-breakpoint
ALTER TABLE `__new_source_segment` RENAME TO `source_segment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `source_segment_track_idx`;--> statement-breakpoint
CREATE INDEX `source_segment_recording_idx` ON `source_segment` (`recording_id`);