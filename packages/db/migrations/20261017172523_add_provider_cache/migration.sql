CREATE TABLE `provider_item` (
	`source_id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`isrc` text,
	`data` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_item_external_idx` ON `provider_item` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `provider_item_isrc_idx` ON `provider_item` (`isrc`);