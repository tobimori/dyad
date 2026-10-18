ALTER TABLE `source` ADD `hlc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `source` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_variant` ADD `hlc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_variant` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `library_item_seq_idx` ON `library_item` (`change_seq`);--> statement-breakpoint
CREATE INDEX `play_event_seq_idx` ON `play_event` (`change_seq`);--> statement-breakpoint
CREATE INDEX `playlist_seq_idx` ON `playlist` (`change_seq`);--> statement-breakpoint
CREATE INDEX `playlist_entry_seq_idx` ON `playlist_entry` (`change_seq`);--> statement-breakpoint
CREATE INDEX `source_change_idx` ON `source` (`change_seq`);--> statement-breakpoint
CREATE INDEX `source_variant_change_idx` ON `source_variant` (`change_seq`);