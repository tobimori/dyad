ALTER TABLE `local_file` ADD `album_artist_key` text;--> statement-breakpoint
ALTER TABLE `local_file` ADD `artist_key` text;--> statement-breakpoint
ALTER TABLE `local_file` ADD `album_key` text;--> statement-breakpoint
CREATE INDEX `local_file_album_idx` ON `local_file` (`album_artist_key`,`album_key`);--> statement-breakpoint
CREATE INDEX `local_file_artist_idx` ON `local_file` (`artist_key`);--> statement-breakpoint
-- The next library sync reads every file again once and sets the new keys
UPDATE `local_file` SET `mtime` = -1;
