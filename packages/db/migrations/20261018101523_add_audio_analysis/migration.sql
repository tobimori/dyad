CREATE TABLE `audio_analysis` (
	`variant_id` text PRIMARY KEY,
	`asset` text NOT NULL,
	`analyzer_version` integer NOT NULL,
	`loudness` real NOT NULL,
	`true_peak` real NOT NULL,
	`leading_silence_ms` integer NOT NULL,
	`trailing_silence_ms` integer NOT NULL,
	`analyzed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `local_file` DROP COLUMN `loudness_lufs`;--> statement-breakpoint
ALTER TABLE `local_file` DROP COLUMN `true_peak`;--> statement-breakpoint
ALTER TABLE `local_file` DROP COLUMN `track_gain`;--> statement-breakpoint
ALTER TABLE `local_file` DROP COLUMN `album_gain`;