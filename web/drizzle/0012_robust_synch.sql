ALTER TABLE `test_datasets` ADD `source_content_type` text;--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `byte_count` integer;--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_test_datasets_owner_idempotency` ON `test_datasets` (`user_id`,`idempotency_key`);