ALTER TABLE `library_remote_track` ADD `id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `library_remote_track` ADD `deleted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `library_remote_track` ADD `hlc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `library_remote_track` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A new `change_seq`, so that paired replicas pull the existing rows
UPDATE `replica_identity` SET `change_seq` = `change_seq` + 1 WHERE EXISTS (SELECT 1 FROM `library_remote_track`);--> statement-breakpoint
UPDATE `library_remote_track` SET
  `id` = `user_id` || ':' || `provider` || ':' || `recording_id`,
  `hlc` = printf('%015d-0000-%s', `seen_at`, (SELECT `replica_id` FROM `replica_identity`)),
  `change_seq` = (SELECT `change_seq` FROM `replica_identity`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_remote_track_id_idx` ON `library_remote_track` (`id`);--> statement-breakpoint
CREATE INDEX `library_remote_track_seq_idx` ON `library_remote_track` (`change_seq`);
