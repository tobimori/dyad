CREATE TABLE `artist` (
	`id` text PRIMARY KEY,
	`local_key` text,
	`name` text,
	`sort_name` text,
	`kind` text,
	`country` text,
	`disambiguation` text,
	`name_key` text,
	`merged_into_id` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artist_credit_name` (
	`artist_credit_id` text NOT NULL,
	`position` integer NOT NULL,
	`artist_id` text,
	`credited_as` text NOT NULL,
	`join_phrase` text DEFAULT '' NOT NULL,
	CONSTRAINT `artist_credit_name_pk` PRIMARY KEY(`artist_credit_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `artist_local_key_idx` ON `artist` (`local_key`);--> statement-breakpoint
CREATE INDEX `artist_name_key_idx` ON `artist` (`name_key`);--> statement-breakpoint
CREATE INDEX `artist_merged_into_idx` ON `artist` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `artist_credit_name_artist_idx` ON `artist_credit_name` (`artist_id`);