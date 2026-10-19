CREATE TABLE `album_artist` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`artist_id` text,
	`name` text NOT NULL,
	`join_phrase` text DEFAULT '' NOT NULL,
	CONSTRAINT `album_artist_pk` PRIMARY KEY(`album_id`, `position`)
);
--> statement-breakpoint
CREATE TABLE `song_artist` (
	`recording_id` text NOT NULL,
	`position` integer NOT NULL,
	`artist_id` text,
	`name` text NOT NULL,
	`join_phrase` text DEFAULT '' NOT NULL,
	CONSTRAINT `song_artist_pk` PRIMARY KEY(`recording_id`, `position`)
);
--> statement-breakpoint
INSERT INTO `song_artist` (`recording_id`, `position`, `artist_id`, `name`, `join_phrase`)
SELECT `recording`.`id`, `n`.`position`, `n`.`artist_id`, `n`.`credited_as`, `n`.`join_phrase`
FROM `recording` JOIN `artist_credit_name` AS `n` ON `n`.`artist_credit_id` = `recording`.`artist_credit_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `artist_credit_name_artist_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `recording_artist_credit_idx`;--> statement-breakpoint
CREATE INDEX `album_artist_artist_idx` ON `album_artist` (`artist_id`);--> statement-breakpoint
CREATE INDEX `song_artist_artist_idx` ON `song_artist` (`artist_id`);--> statement-breakpoint
DROP TABLE `artist_credit`;--> statement-breakpoint
DROP TABLE `artist_credit_name`;--> statement-breakpoint
ALTER TABLE `album` DROP COLUMN `artist_id`;--> statement-breakpoint
ALTER TABLE `edition` DROP COLUMN `artist_id`;--> statement-breakpoint
ALTER TABLE `recording` DROP COLUMN `artist_credit_id`;