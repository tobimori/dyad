CREATE TABLE `source_segment` (
	`source_id` text NOT NULL,
	`position` integer NOT NULL,
	`track_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	CONSTRAINT `source_segment_pk` PRIMARY KEY(`source_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `source_segment_track_idx` ON `source_segment` (`track_id`);