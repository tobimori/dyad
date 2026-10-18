ALTER TABLE `library_remote_playlist` ADD `snapshot` text;--> statement-breakpoint
ALTER TABLE `library_remote_playlist` ADD `name` text;--> statement-breakpoint
ALTER TABLE `playlist` ADD `link` text;--> statement-breakpoint
UPDATE `replica_identity` SET `change_seq` = `change_seq` + 1 WHERE `slot` = 1;--> statement-breakpoint
UPDATE `library_remote_playlist` SET
  `name` = (SELECT `name` FROM `playlist` WHERE `playlist`.`id` = `library_remote_playlist`.`playlist_id`),
  `snapshot` = (
    SELECT json_group_array(`recording_id` ORDER BY `position`, `id`) FROM `playlist_entry`
    WHERE `playlist_entry`.`playlist_id` = `library_remote_playlist`.`playlist_id` AND `deleted` = 0
  );--> statement-breakpoint
UPDATE `playlist` SET
  `link` = json_object(
    'provider', substr(`origin`, 9),
    'remoteId', (SELECT `remote_id` FROM `library_remote_playlist` WHERE `playlist_id` = `playlist`.`id`),
    'direction', 'import'
  ),
  `hlc` = printf('%015d', max(
    CAST(substr(`hlc`, 1, 15) AS INTEGER) + 1,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  )) || '-0000-' || (SELECT `replica_id` FROM `replica_identity` WHERE `slot` = 1),
  `field_hlc` = NULL,
  `change_seq` = (SELECT `change_seq` FROM `replica_identity` WHERE `slot` = 1)
WHERE `origin` LIKE 'account:%' AND `deleted` = 0
  AND EXISTS (SELECT 1 FROM `library_remote_playlist` WHERE `playlist_id` = `playlist`.`id`);
