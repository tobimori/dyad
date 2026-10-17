CREATE TABLE `catalog_assertion` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`origin` text NOT NULL,
	`origin_ref` text NOT NULL,
	`origin_revision` text,
	`evidence` text,
	`confidence` real NOT NULL,
	`author_user_id` text NOT NULL,
	`author_replica_id` text NOT NULL,
	`hlc` text NOT NULL,
	`retracted` integer DEFAULT false NOT NULL,
	`schema_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artist` (
	`id` text PRIMARY KEY,
	`local_key` text,
	`name` text,
	`sort_name` text,
	`kind` text,
	`country` text,
	`disambiguation` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artist_credit` (
	`id` text PRIMARY KEY,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artist_credit_name` (
	`artist_credit_id` text NOT NULL,
	`position` integer NOT NULL,
	`artist_id` text NOT NULL,
	`credited_as` text NOT NULL,
	`join_phrase` text DEFAULT '' NOT NULL,
	CONSTRAINT `artist_credit_name_pk` PRIMARY KEY(`artist_credit_id`, `position`)
);
--> statement-breakpoint
CREATE TABLE `entity_merge` (
	`id` text PRIMARY KEY,
	`entity_type` text NOT NULL,
	`from_id` text NOT NULL,
	`into_id` text NOT NULL,
	`decision` text NOT NULL,
	`origin` text NOT NULL,
	`author_user_id` text NOT NULL,
	`hlc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identifier` (
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`scheme` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `identifier_pk` PRIMARY KEY(`entity_type`, `entity_id`, `scheme`, `value`)
);
--> statement-breakpoint
CREATE TABLE `medium` (
	`id` text PRIMARY KEY,
	`release_id` text,
	`position` integer,
	`format` text,
	`title` text,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recording` (
	`id` text PRIMARY KEY,
	`title` text,
	`artist_credit_id` text,
	`duration_ms` integer,
	`disambiguation` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release` (
	`id` text PRIMARY KEY,
	`release_group_id` text,
	`title` text,
	`artist_credit_id` text,
	`date` text,
	`country` text,
	`release_status` text,
	`label` text,
	`catalog_number` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_group` (
	`id` text PRIMARY KEY,
	`local_key` text,
	`title` text,
	`artist_credit_id` text,
	`primary_type` text,
	`classification_status` text DEFAULT 'uncertain' NOT NULL,
	`secondary_types` text DEFAULT '[]' NOT NULL,
	`first_release_date` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `track` (
	`id` text PRIMARY KEY,
	`medium_id` text,
	`position` integer,
	`number` text,
	`title` text,
	`artist_credit_id` text,
	`recording_id` text,
	`duration_ms` integer,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_root` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`path` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_file` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`library_root_id` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` integer NOT NULL,
	`audio_hash` text NOT NULL,
	`tags` text NOT NULL,
	`fingerprint` text,
	`loudness_lufs` real,
	`true_peak` real,
	`track_gain` real,
	`album_gain` real,
	`scanned_at` integer NOT NULL,
	CONSTRAINT `fk_local_file_library_root_id_library_root_id_fk` FOREIGN KEY (`library_root_id`) REFERENCES `library_root`(`id`) ON DELETE CASCADE
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
CREATE TABLE `source_match` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`recording_id` text,
	`track_id` text,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`matched_at` integer NOT NULL
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
CREATE INDEX `catalog_assertion_entity_idx` ON `catalog_assertion` (`entity_type`,`entity_id`,`field`);--> statement-breakpoint
CREATE INDEX `catalog_assertion_origin_idx` ON `catalog_assertion` (`origin_ref`);--> statement-breakpoint
CREATE INDEX `artist_local_key_idx` ON `artist` (`local_key`);--> statement-breakpoint
CREATE INDEX `artist_credit_name_artist_idx` ON `artist_credit_name` (`artist_id`);--> statement-breakpoint
CREATE INDEX `entity_merge_from_idx` ON `entity_merge` (`entity_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `entity_merge_into_idx` ON `entity_merge` (`entity_type`,`into_id`);--> statement-breakpoint
CREATE INDEX `identifier_lookup_idx` ON `identifier` (`scheme`,`value`);--> statement-breakpoint
CREATE INDEX `medium_release_idx` ON `medium` (`release_id`,`position`);--> statement-breakpoint
CREATE INDEX `recording_artist_credit_idx` ON `recording` (`artist_credit_id`);--> statement-breakpoint
CREATE INDEX `release_release_group_idx` ON `release` (`release_group_id`);--> statement-breakpoint
CREATE INDEX `release_artist_credit_idx` ON `release` (`artist_credit_id`);--> statement-breakpoint
CREATE INDEX `release_group_artist_credit_idx` ON `release_group` (`artist_credit_id`);--> statement-breakpoint
CREATE INDEX `release_group_local_key_idx` ON `release_group` (`local_key`);--> statement-breakpoint
CREATE INDEX `track_medium_idx` ON `track` (`medium_id`,`position`);--> statement-breakpoint
CREATE INDEX `track_recording_idx` ON `track` (`recording_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_file_path_idx` ON `local_file` (`library_root_id`,`path`);--> statement-breakpoint
CREATE INDEX `local_file_source_idx` ON `local_file` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_provider_idx` ON `source` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `source_recording_idx` ON `source` (`recording_id`);--> statement-breakpoint
CREATE INDEX `source_track_idx` ON `source` (`track_id`);--> statement-breakpoint
CREATE INDEX `source_match_source_idx` ON `source_match` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_match_recording_idx` ON `source_match` (`recording_id`);--> statement-breakpoint
CREATE INDEX `source_variant_source_idx` ON `source_variant` (`source_id`);