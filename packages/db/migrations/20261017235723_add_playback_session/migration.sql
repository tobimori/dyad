CREATE TABLE `playback_session` (
	`user_id` text PRIMARY KEY,
	`entries` text NOT NULL,
	`next_entry_id` integer NOT NULL,
	`queue_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`playback` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_playback_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
