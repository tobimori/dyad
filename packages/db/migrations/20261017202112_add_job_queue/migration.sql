CREATE TABLE `job` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`priority` integer NOT NULL,
	`next_run_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`last_error` text,
	`started_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `job_pk` PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX `job_next_run_idx` ON `job` (`next_run_at`);