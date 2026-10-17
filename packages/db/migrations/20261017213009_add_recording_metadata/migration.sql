CREATE TABLE `isrc_lookup` (
	`isrc` text PRIMARY KEY,
	`recordings` text NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `recording` ADD `artist_name` text;--> statement-breakpoint
ALTER TABLE `recording` ADD `album` text;--> statement-breakpoint
ALTER TABLE `recording` ADD `artwork_url` text;--> statement-breakpoint
ALTER TABLE `recording` ADD `explicit` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_catalog_assertion` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`origin` text NOT NULL,
	`origin_ref` text NOT NULL,
	`origin_revision` text,
	`evidence` text,
	`confidence` real NOT NULL,
	`author_user_id` text,
	`author_replica_id` text NOT NULL,
	`hlc` text NOT NULL,
	`retracted` integer DEFAULT false NOT NULL,
	`schema_version` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_catalog_assertion`(`id`, `workspace_id`, `entity_type`, `entity_id`, `field`, `value`, `origin`, `origin_ref`, `origin_revision`, `evidence`, `confidence`, `author_user_id`, `author_replica_id`, `hlc`, `retracted`, `schema_version`) SELECT `id`, `workspace_id`, `entity_type`, `entity_id`, `field`, `value`, `origin`, `origin_ref`, `origin_revision`, `evidence`, `confidence`, `author_user_id`, `author_replica_id`, `hlc`, `retracted`, `schema_version` FROM `catalog_assertion`;--> statement-breakpoint
DROP TABLE `catalog_assertion`;--> statement-breakpoint
ALTER TABLE `__new_catalog_assertion` RENAME TO `catalog_assertion`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `catalog_assertion_entity_idx` ON `catalog_assertion` (`entity_type`,`entity_id`,`field`);--> statement-breakpoint
CREATE INDEX `catalog_assertion_origin_idx` ON `catalog_assertion` (`origin_ref`);