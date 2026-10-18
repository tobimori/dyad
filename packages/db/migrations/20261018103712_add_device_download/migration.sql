CREATE TABLE `device_download` (
	`device_id` text NOT NULL,
	`source_id` text NOT NULL,
	`quality` text NOT NULL,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `device_download_pk` PRIMARY KEY(`device_id`, `source_id`),
	CONSTRAINT `fk_device_download_device_id_device_id_fk` FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON DELETE CASCADE
);
