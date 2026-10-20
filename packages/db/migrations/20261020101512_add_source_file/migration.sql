CREATE TABLE `source_file` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`replica_id` text NOT NULL,
	`deleted` integer NOT NULL,
	`hlc` text NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_file_source_idx` ON `source_file` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_file_change_idx` ON `source_file` (`change_seq`);