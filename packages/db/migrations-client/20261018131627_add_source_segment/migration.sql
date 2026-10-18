CREATE TABLE `source_segment` (
	`source_id` text NOT NULL,
	`position` integer NOT NULL,
	`recording_id` text,
	`raw_artist` text,
	`raw_title` text,
	`start_ms` integer,
	`end_ms` integer,
	CONSTRAINT `source_segment_pk` PRIMARY KEY(`source_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `source_segment_recording_idx` ON `source_segment` (`recording_id`);--> statement-breakpoint
-- Groups that the client has already synced come again with their segments
DELETE FROM `client_state` WHERE `key` = 'catalogCursor';
