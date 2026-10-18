CREATE TABLE `client_state` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
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
	`deleted` integer NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
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
CREATE TABLE `play_event` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`source_id` text NOT NULL,
	`recording_id` text,
	`started_at` integer NOT NULL,
	`played_ms` integer NOT NULL,
	`completed` integer NOT NULL,
	`context` text NOT NULL,
	`scrobbled` integer DEFAULT false NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`origin` text,
	`created_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`deleted` integer NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist_entry` (
	`id` text PRIMARY KEY,
	`playlist_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`position` text NOT NULL,
	`added_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`deleted` integer NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recording` (
	`id` text PRIMARY KEY,
	`title` text,
	`artist_credit_id` text,
	`duration_ms` integer,
	`disambiguation` text,
	`artist_name` text,
	`album` text,
	`artwork_url` text,
	`explicit` integer,
	`merged_into_id` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`recording_id` text,
	`track_id` text,
	`raw_title` text,
	`raw_artist` text,
	`raw_album` text,
	`raw_duration_ms` integer,
	`availability` text DEFAULT 'available' NOT NULL,
	`checked_at` integer,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_key` (
	`source_id` text PRIMARY KEY,
	`album_artist_key` text,
	`artist_key` text,
	`album_key` text
);
--> statement-breakpoint
CREATE TABLE `source_variant` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`codec` text NOT NULL,
	`container` text NOT NULL,
	`sample_rate` integer,
	`bit_depth` integer,
	`channels` integer,
	`bitrate` integer,
	`lossless` integer NOT NULL,
	`encrypted` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_queue` (
	`mutation_id` integer PRIMARY KEY,
	`mutation` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_scope` (
	`scope` text PRIMARY KEY,
	`change_seq` integer NOT NULL,
	`row_key` text,
	`loaded_at` integer
);
--> statement-breakpoint
CREATE INDEX `library_item_user_idx` ON `library_item` (`user_id`,`deleted`);--> statement-breakpoint
CREATE INDEX `library_item_entity_idx` ON `library_item` (`entity_id`);--> statement-breakpoint
CREATE INDEX `library_item_change_idx` ON `library_item` (`user_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `play_event_user_started_idx` ON `play_event` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `play_event_change_idx` ON `play_event` (`user_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `playlist_owner_idx` ON `playlist` (`owner_id`,`deleted`);--> statement-breakpoint
CREATE INDEX `playlist_entry_playlist_idx` ON `playlist_entry` (`playlist_id`,`deleted`);--> statement-breakpoint
CREATE INDEX `playlist_entry_change_idx` ON `playlist_entry` (`playlist_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `recording_artist_credit_idx` ON `recording` (`artist_credit_id`);--> statement-breakpoint
CREATE INDEX `recording_merged_into_idx` ON `recording` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `recording_revision_idx` ON `recording` (`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_provider_idx` ON `source` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `source_recording_idx` ON `source` (`recording_id`);--> statement-breakpoint
CREATE INDEX `source_track_idx` ON `source` (`track_id`);--> statement-breakpoint
CREATE INDEX `source_variant_source_idx` ON `source_variant` (`source_id`);