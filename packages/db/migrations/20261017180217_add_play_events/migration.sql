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
	`scrobbled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `play_event_user_started_idx` ON `play_event` (`user_id`,`started_at`);