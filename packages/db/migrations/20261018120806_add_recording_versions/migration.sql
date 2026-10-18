CREATE TABLE `recording_derivative` (
	`recording_id` text NOT NULL,
	`original_id` text NOT NULL,
	`part` integer,
	`kind` text NOT NULL,
	CONSTRAINT `recording_derivative_pk` PRIMARY KEY(`recording_id`, `original_id`)
);
--> statement-breakpoint
CREATE TABLE `artist_lookup` (
	`name_key` text PRIMARY KEY,
	`artists` text NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `artist` ADD `name_key` text;--> statement-breakpoint
ALTER TABLE `artist` ADD `merged_into_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artist_credit_name` (
	`artist_credit_id` text NOT NULL,
	`position` integer NOT NULL,
	`artist_id` text,
	`credited_as` text NOT NULL,
	`join_phrase` text DEFAULT '' NOT NULL,
	CONSTRAINT `artist_credit_name_pk` PRIMARY KEY(`artist_credit_id`, `position`)
);
--> statement-breakpoint
INSERT INTO `__new_artist_credit_name`(`artist_credit_id`, `position`, `artist_id`, `credited_as`, `join_phrase`) SELECT `artist_credit_id`, `position`, `artist_id`, `credited_as`, `join_phrase` FROM `artist_credit_name`;--> statement-breakpoint
DROP TABLE `artist_credit_name`;--> statement-breakpoint
ALTER TABLE `__new_artist_credit_name` RENAME TO `artist_credit_name`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `artist_credit_name_artist_idx` ON `artist_credit_name` (`artist_id`);--> statement-breakpoint
CREATE INDEX `artist_name_key_idx` ON `artist` (`name_key`);--> statement-breakpoint
CREATE INDEX `artist_merged_into_idx` ON `artist` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `recording_derivative_original_idx` ON `recording_derivative` (`original_id`);