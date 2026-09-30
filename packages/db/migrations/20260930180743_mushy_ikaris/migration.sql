CREATE TABLE `replica_identity` (
	`slot` integer PRIMARY KEY,
	`replica_id` text NOT NULL UNIQUE,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL
);
