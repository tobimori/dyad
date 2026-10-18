CREATE TABLE `rating` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`favorite` integer NOT NULL,
	`hlc` text NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rating_user_idx` ON `rating` (`user_id`,`favorite`);--> statement-breakpoint
CREATE INDEX `rating_change_idx` ON `rating` (`user_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `rating_seq_idx` ON `rating` (`change_seq`);