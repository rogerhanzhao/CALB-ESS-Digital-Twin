CREATE TABLE `cell_products` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`manufacturer` text NOT NULL,
	`model` text NOT NULL,
	`chemistry` text DEFAULT 'LFP' NOT NULL,
	`nominal_capacity_ah` real NOT NULL,
	`nominal_voltage_v` real NOT NULL,
	`revision` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cell_products_user_created` ON `cell_products` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cell_products_owner_model_revision` ON `cell_products` (`user_id`,`model`,`revision`);--> statement-breakpoint
CREATE TABLE `test_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`test_type` text NOT NULL,
	`batch_code` text NOT NULL,
	`source_lab` text NOT NULL,
	`file_name` text NOT NULL,
	`storage_uri` text,
	`checksum_sha256` text,
	`row_count` integer,
	`unit_schema` text NOT NULL,
	`status` text DEFAULT 'registered' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `cell_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_test_datasets_product_created` ON `test_datasets` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_test_datasets_user_created` ON `test_datasets` (`user_id`,`created_at`);