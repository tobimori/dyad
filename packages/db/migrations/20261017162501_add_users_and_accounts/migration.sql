CREATE TABLE `credential` (
	`provider_account_id` text PRIMARY KEY,
	`values` text NOT NULL,
	CONSTRAINT `fk_credential_provider_account_id_provider_account_id_fk` FOREIGN KEY (`provider_account_id`) REFERENCES `provider_account`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `provider_account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_provider_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_device_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`username` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_account_user_idx` ON `provider_account` (`user_id`,`provider`);--> statement-breakpoint
CREATE INDEX `device_user_idx` ON `device` (`user_id`);