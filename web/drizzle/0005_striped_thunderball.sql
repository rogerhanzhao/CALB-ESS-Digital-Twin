CREATE TABLE `cell_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sample_code` text NOT NULL,
	`batch_code` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `cell_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cell_samples_owner_code` ON `cell_samples` (`user_id`,`sample_code`);--> statement-breakpoint
CREATE INDEX `idx_cell_samples_product` ON `cell_samples` (`product_id`);--> statement-breakpoint
CREATE TABLE `dataset_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`revision` text NOT NULL,
	`mapping_version` text NOT NULL,
	`cleaning_rule_version` text NOT NULL,
	`code_revision` text NOT NULL,
	`output_uri` text,
	`output_checksum_sha256` text,
	`row_count` integer,
	`validation_status` text DEFAULT 'pending' NOT NULL,
	`validation_report_uri` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `test_datasets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dataset_revisions_dataset_revision` ON `dataset_revisions` (`dataset_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_dataset_revisions_user_created` ON `dataset_revisions` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `sample_id` text NOT NULL REFERENCES cell_samples(id);--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `schema_version` text DEFAULT 'V0.2' NOT NULL;--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `equipment_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `operator` text NOT NULL;--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `test_started_at` text NOT NULL;--> statement-breakpoint
ALTER TABLE `test_datasets` ADD `test_ended_at` text NOT NULL;