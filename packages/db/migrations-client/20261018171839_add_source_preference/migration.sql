CREATE TABLE `source_preference` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`provider_ranking` text NOT NULL,
	`hlc` text NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_preference_change_idx` ON `source_preference` (`user_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `source_preference_seq_idx` ON `source_preference` (`change_seq`);