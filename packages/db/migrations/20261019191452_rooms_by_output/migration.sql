CREATE TABLE `__new_playback_session` (
	`room` text PRIMARY KEY,
	`name` text NOT NULL,
	`entries` text NOT NULL,
	`next_entry_id` integer NOT NULL,
	`queue_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`playback` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_playback_session`(`room`, `name`, `entries`, `next_entry_id`, `queue_version`, `revision`, `playback`, `updated_at`)
SELECT json_extract(`playback`, '$.outputId'),
	coalesce((SELECT `name` FROM `device` WHERE 'device:' || `device`.`id` = json_extract(`playback`, '$.outputId')), json_extract(`playback`, '$.outputId')),
	`entries`, `next_entry_id`, `queue_version`, `revision`, `playback`, `updated_at`
FROM `playback_session` WHERE json_extract(`playback`, '$.outputId') IS NOT NULL;--> statement-breakpoint
DROP TABLE `playback_session`;--> statement-breakpoint
ALTER TABLE `__new_playback_session` RENAME TO `playback_session`;
