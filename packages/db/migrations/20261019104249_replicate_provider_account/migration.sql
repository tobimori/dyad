ALTER TABLE `provider_account` ADD `deleted` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing rows get an HLC from their link time, so that the default never stays
ALTER TABLE `provider_account` ADD `hlc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_account` ADD `change_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `provider_account_seq_idx` ON `provider_account` (`change_seq`);--> statement-breakpoint
-- A new `change_seq`, so that paired replicas pull the existing accounts
UPDATE `replica_identity` SET `change_seq` = `change_seq` + 1 WHERE EXISTS (SELECT 1 FROM `provider_account`);--> statement-breakpoint
UPDATE `provider_account` SET
  `hlc` = printf('%015d-0000-%s', `created_at`, (SELECT `replica_id` FROM `replica_identity`)),
  `change_seq` = (SELECT `change_seq` FROM `replica_identity`);
