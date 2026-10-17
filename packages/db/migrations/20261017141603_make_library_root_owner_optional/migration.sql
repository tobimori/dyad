PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_library_root` (
	`id` text PRIMARY KEY,
	`owner_id` text,
	`path` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_library_root`(`id`, `owner_id`, `path`, `created_at`) SELECT `id`, `owner_id`, `path`, `created_at` FROM `library_root`;--> statement-breakpoint
DROP TABLE `library_root`;--> statement-breakpoint
ALTER TABLE `__new_library_root` RENAME TO `library_root`;--> statement-breakpoint
PRAGMA foreign_keys=ON;