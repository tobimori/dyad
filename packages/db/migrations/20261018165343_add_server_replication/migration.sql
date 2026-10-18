CREATE TABLE `server_peer` (
	`replica_id` text PRIMARY KEY,
	`url` text,
	`token` text,
	`token_hash` text UNIQUE,
	`epoch` text,
	`pulled_seq` integer DEFAULT 0 NOT NULL,
	`pulled_row_key` text,
	`pushed_seq` integer DEFAULT 0 NOT NULL,
	`pushed_row_key` text,
	`created_at` integer NOT NULL,
	`synced_at` integer,
	`error` text
);
--> statement-breakpoint
ALTER TABLE `catalog_assertion` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_merge` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `source` ADD `hlc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `source` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_variant` ADD `hlc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_variant` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `catalog_assertion_change_idx` ON `catalog_assertion` (`change_seq`);--> statement-breakpoint
CREATE INDEX `entity_merge_change_idx` ON `entity_merge` (`change_seq`);--> statement-breakpoint
CREATE INDEX `play_event_seq_idx` ON `play_event` (`change_seq`);--> statement-breakpoint
CREATE INDEX `library_item_seq_idx` ON `library_item` (`change_seq`);--> statement-breakpoint
CREATE INDEX `playlist_seq_idx` ON `playlist` (`change_seq`);--> statement-breakpoint
CREATE INDEX `playlist_entry_seq_idx` ON `playlist_entry` (`change_seq`);--> statement-breakpoint
CREATE INDEX `source_change_idx` ON `source` (`change_seq`);--> statement-breakpoint
CREATE INDEX `source_variant_change_idx` ON `source_variant` (`change_seq`);--> statement-breakpoint
UPDATE `catalog_assertion` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `entity_merge` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `source` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `source_variant` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `replica_identity` SET `change_seq` = max(`change_seq`, 1);
