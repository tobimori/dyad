-- Migrations run in a transaction, where `foreign_keys` cannot change. Dropping a parent table
-- deletes its child rows, so they wait in a copy.
CREATE TABLE `__keep_credential` AS SELECT * FROM `credential`;--> statement-breakpoint
CREATE TABLE `__keep_device_download` AS SELECT * FROM `device_download`;--> statement-breakpoint
CREATE TABLE `__new_provider_account` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`hlc` text NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_provider_account`(`id`, `provider`, `display_name`, `created_at`, `deleted`, `hlc`, `change_seq`) SELECT `id`, `provider`, `display_name`, `created_at`, `deleted`, `hlc`, `change_seq` FROM `provider_account`;--> statement-breakpoint
DROP TABLE `provider_account`;--> statement-breakpoint
ALTER TABLE `__new_provider_account` RENAME TO `provider_account`;--> statement-breakpoint
CREATE TABLE `__new_device` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_device`(`id`, `name`, `token_hash`, `created_at`) SELECT `id`, `name`, `token_hash`, `created_at` FROM `device`;--> statement-breakpoint
DROP TABLE `device`;--> statement-breakpoint
ALTER TABLE `__new_device` RENAME TO `device`;--> statement-breakpoint
INSERT INTO `credential` SELECT * FROM `__keep_credential`;--> statement-breakpoint
INSERT INTO `device_download` SELECT * FROM `__keep_device_download`;--> statement-breakpoint
DROP TABLE `__keep_credential`;--> statement-breakpoint
DROP TABLE `__keep_device_download`;--> statement-breakpoint
CREATE TABLE `__new_playback_session` (
	`slot` integer PRIMARY KEY,
	`entries` text NOT NULL,
	`next_entry_id` integer NOT NULL,
	`queue_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`playback` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_playback_session`(`slot`, `entries`, `next_entry_id`, `queue_version`, `revision`, `playback`, `updated_at`) SELECT 1, `entries`, `next_entry_id`, `queue_version`, `revision`, `playback`, `updated_at` FROM `playback_session` LIMIT 1;--> statement-breakpoint
DROP TABLE `playback_session`;--> statement-breakpoint
ALTER TABLE `__new_playback_session` RENAME TO `playback_session`;--> statement-breakpoint
CREATE TABLE `__new_library_remote_playlist` (
	`provider` text NOT NULL,
	`remote_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`version` text,
	`snapshot` text,
	`name` text,
	`last_complete_at` integer,
	`incomplete_reason` text,
	CONSTRAINT `library_remote_playlist_pk` PRIMARY KEY(`provider`, `remote_id`)
);
--> statement-breakpoint
INSERT INTO `__new_library_remote_playlist`(`provider`, `remote_id`, `playlist_id`, `version`, `snapshot`, `name`, `last_complete_at`, `incomplete_reason`) SELECT `provider`, `remote_id`, `playlist_id`, `version`, `snapshot`, `name`, `last_complete_at`, `incomplete_reason` FROM `library_remote_playlist`;--> statement-breakpoint
DROP TABLE `library_remote_playlist`;--> statement-breakpoint
ALTER TABLE `__new_library_remote_playlist` RENAME TO `library_remote_playlist`;--> statement-breakpoint
CREATE TABLE `__new_library_remote_track` (
	`id` text NOT NULL,
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
	`deleted` integer DEFAULT false NOT NULL,
	`hlc` text NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `library_remote_track_pk` PRIMARY KEY(`provider`, `recording_id`)
);
--> statement-breakpoint
INSERT INTO `__new_library_remote_track`(`id`, `provider`, `recording_id`, `remote_id`, `catalog_id`, `source_id`, `raw_title`, `raw_artist`, `raw_album`, `raw_duration_ms`, `seen_at`, `deleted`, `hlc`, `change_seq`) SELECT `provider` || ':' || `recording_id`, `provider`, `recording_id`, `remote_id`, `catalog_id`, `source_id`, `raw_title`, `raw_artist`, `raw_album`, `raw_duration_ms`, `seen_at`, `deleted`, `hlc`, `change_seq` FROM `library_remote_track`;--> statement-breakpoint
DROP TABLE `library_remote_track`;--> statement-breakpoint
ALTER TABLE `__new_library_remote_track` RENAME TO `library_remote_track`;--> statement-breakpoint
CREATE TABLE `__new_library_sync_state` (
	`provider` text PRIMARY KEY,
	`songs_version` text,
	`last_complete_at` integer,
	`last_full_read_at` integer,
	`last_attempt_at` integer,
	`status` text,
	`incomplete_reason` text,
	`error` text,
	`throttle_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_library_sync_state`(`provider`, `songs_version`, `last_complete_at`, `last_full_read_at`, `last_attempt_at`, `status`, `incomplete_reason`, `error`, `throttle_count`) SELECT `provider`, `songs_version`, `last_complete_at`, `last_full_read_at`, `last_attempt_at`, `status`, `incomplete_reason`, `error`, `throttle_count` FROM `library_sync_state`;--> statement-breakpoint
DROP TABLE `library_sync_state`;--> statement-breakpoint
ALTER TABLE `__new_library_sync_state` RENAME TO `library_sync_state`;--> statement-breakpoint
DROP INDEX IF EXISTS `provider_account_user_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `play_event_user_started_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `play_event_change_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `library_item_user_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `library_item_change_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `rating_user_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `rating_change_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `device_user_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `playlist_owner_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `source_preference_change_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_account_provider_idx` ON `provider_account` (`provider`);--> statement-breakpoint
CREATE INDEX `provider_account_seq_idx` ON `provider_account` (`change_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_remote_track_id_idx` ON `library_remote_track` (`id`);--> statement-breakpoint
CREATE INDEX `library_remote_track_seq_idx` ON `library_remote_track` (`change_seq`);--> statement-breakpoint
CREATE INDEX `play_event_started_idx` ON `play_event` (`started_at`);--> statement-breakpoint
CREATE INDEX `library_item_origin_idx` ON `library_item` (`origin`,`deleted`);--> statement-breakpoint
CREATE INDEX `rating_favorite_idx` ON `rating` (`favorite`);--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `catalog_assertion` DROP COLUMN `author_user_id`;--> statement-breakpoint
ALTER TABLE `entity_merge` DROP COLUMN `author_user_id`;--> statement-breakpoint
ALTER TABLE `play_event` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `library_item` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `playlist` DROP COLUMN `owner_id`;--> statement-breakpoint
ALTER TABLE `rating` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `source_preference` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `library_root` DROP COLUMN `owner_id`;--> statement-breakpoint
-- Job keys of accounts were `<user_id>:<provider>`
UPDATE `job` SET `key` = substr(`key`, instr(`key`, ':') + 1) WHERE `kind` IN ('provider.library', 'recommender.scrobble') AND `key` LIKE '%-%-%-%-%:%';
