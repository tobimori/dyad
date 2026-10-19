CREATE TABLE `album` (
	`id` text PRIMARY KEY,
	`title` text,
	`artist_name` text,
	`artist_id` text,
	`type` text,
	`year` integer,
	`artwork_url` text,
	`merged_into_id` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `edition` (
	`id` text PRIMARY KEY,
	`album_id` text,
	`title` text,
	`edition_words` text,
	`artist_name` text,
	`artist_id` text,
	`date` text,
	`label` text,
	`upc` text,
	`artwork_url` text,
	`merged_into_id` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `edition_track` (
	`id` text PRIMARY KEY,
	`edition_id` text NOT NULL,
	`disc` integer NOT NULL,
	`position` integer NOT NULL,
	`recording_id` text NOT NULL,
	`title` text,
	`artist_name` text,
	`duration_ms` integer
);
--> statement-breakpoint
DROP INDEX IF EXISTS `medium_release_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `release_release_group_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `release_artist_credit_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `release_group_artist_credit_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `release_group_local_key_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `track_medium_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `track_recording_idx`;--> statement-breakpoint
CREATE INDEX `album_merged_into_idx` ON `album` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `edition_album_idx` ON `edition` (`album_id`);--> statement-breakpoint
CREATE INDEX `edition_merged_into_idx` ON `edition` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `edition_upc_idx` ON `edition` (`upc`);--> statement-breakpoint
CREATE INDEX `edition_track_edition_idx` ON `edition_track` (`edition_id`,`disc`,`position`);--> statement-breakpoint
CREATE INDEX `edition_track_recording_idx` ON `edition_track` (`recording_id`);--> statement-breakpoint
DROP TABLE `medium`;--> statement-breakpoint
DROP TABLE `release`;--> statement-breakpoint
DROP TABLE `release_group`;--> statement-breakpoint
DROP TABLE `track`;