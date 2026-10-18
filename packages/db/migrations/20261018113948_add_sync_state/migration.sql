CREATE TABLE `replica` (
	`replica_id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`last_mutation_id` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_rejection` (
	`replica_id` text NOT NULL,
	`mutation_id` integer NOT NULL,
	`reason` text NOT NULL,
	CONSTRAINT `sync_rejection_pk` PRIMARY KEY(`replica_id`, `mutation_id`)
);
--> statement-breakpoint
ALTER TABLE `play_event` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `library_item` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `playlist` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `playlist_entry` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `replica_identity` ADD `epoch` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `replica_identity` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `recording_revision_idx` ON `recording` (`revision`);--> statement-breakpoint
CREATE INDEX `play_event_change_idx` ON `play_event` (`user_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `library_item_change_idx` ON `library_item` (`user_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `playlist_entry_change_idx` ON `playlist_entry` (`playlist_id`,`change_seq`);--> statement-breakpoint
UPDATE `play_event` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `library_item` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `playlist` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `playlist_entry` SET `change_seq` = 1;--> statement-breakpoint
UPDATE `replica_identity` SET `change_seq` = 1, `epoch` = lower(
	hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
	substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
);
