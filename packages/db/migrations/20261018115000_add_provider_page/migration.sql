CREATE TABLE `provider_page` (
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`data` text NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT `provider_page_pk` PRIMARY KEY(`provider`, `kind`, `external_id`)
);
