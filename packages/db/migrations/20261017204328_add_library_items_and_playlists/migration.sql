CREATE TABLE `library_remote_playlist` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`remote_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`version` text,
	`last_complete_at` integer,
	`incomplete_reason` text,
	CONSTRAINT `library_remote_playlist_pk` PRIMARY KEY(`user_id`, `provider`, `remote_id`)
);
--> statement-breakpoint
CREATE TABLE `library_remote_track` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`recording_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`catalog_id` text,
	`source_id` text,
	`raw_title` text NOT NULL,
	`raw_artist` text,
	`raw_album` text,
	`raw_duration_ms` integer,
	`seen_at` integer NOT NULL,
	CONSTRAINT `library_remote_track_pk` PRIMARY KEY(`user_id`, `provider`, `recording_id`)
);
--> statement-breakpoint
CREATE TABLE `library_sync_state` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`songs_version` text,
	`last_complete_at` integer,
	`last_full_read_at` integer,
	`last_attempt_at` integer,
	`status` text,
	`incomplete_reason` text,
	`error` text,
	`throttle_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `library_sync_state_pk` PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `library_item` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`origin` text NOT NULL,
	`added_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`deleted` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`origin` text,
	`created_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`deleted` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist_entry` (
	`id` text PRIMARY KEY,
	`playlist_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`position` text NOT NULL,
	`added_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`deleted` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_item_user_idx` ON `library_item` (`user_id`,`deleted`);--> statement-breakpoint
CREATE INDEX `library_item_entity_idx` ON `library_item` (`entity_id`);--> statement-breakpoint
CREATE INDEX `playlist_owner_idx` ON `playlist` (`owner_id`,`deleted`);--> statement-breakpoint
CREATE INDEX `playlist_entry_playlist_idx` ON `playlist_entry` (`playlist_id`,`deleted`);