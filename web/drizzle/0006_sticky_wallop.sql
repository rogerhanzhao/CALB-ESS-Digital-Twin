PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cell_products` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`manufacturer` text NOT NULL,
	`model` text NOT NULL,
	`chemistry` text DEFAULT 'LFP' NOT NULL,
	`nominal_capacity_ah` real NOT NULL,
	`nominal_voltage_v` real NOT NULL,
	`revision` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "ck_cell_products_status" CHECK("__new_cell_products"."status" in ('draft', 'under_review', 'released', 'retired'))
);
--> statement-breakpoint
INSERT INTO `__new_cell_products`("id", "user_id", "manufacturer", "model", "chemistry", "nominal_capacity_ah", "nominal_voltage_v", "revision", "status", "created_at") SELECT "id", "user_id", "manufacturer", "model", "chemistry", "nominal_capacity_ah", "nominal_voltage_v", "revision", "status", "created_at" FROM `cell_products`;--> statement-breakpoint
DROP TABLE `cell_products`;--> statement-breakpoint
ALTER TABLE `__new_cell_products` RENAME TO `cell_products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_cell_products_user_created` ON `cell_products` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cell_products_owner_make_model_revision` ON `cell_products` (`user_id`,`manufacturer`,`model`,`revision`);--> statement-breakpoint
CREATE TABLE `__new_dataset_revisions` (
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
	FOREIGN KEY (`dataset_id`) REFERENCES `test_datasets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_dataset_revisions_validation_status" CHECK("__new_dataset_revisions"."validation_status" in ('pending', 'pass', 'warning', 'reject'))
);
--> statement-breakpoint
INSERT INTO `__new_dataset_revisions`("id", "user_id", "dataset_id", "revision", "mapping_version", "cleaning_rule_version", "code_revision", "output_uri", "output_checksum_sha256", "row_count", "validation_status", "validation_report_uri", "created_at") SELECT "id", "user_id", "dataset_id", "revision", "mapping_version", "cleaning_rule_version", "code_revision", "output_uri", "output_checksum_sha256", "row_count", "validation_status", "validation_report_uri", "created_at" FROM `dataset_revisions`;--> statement-breakpoint
DROP TABLE `dataset_revisions`;--> statement-breakpoint
ALTER TABLE `__new_dataset_revisions` RENAME TO `dataset_revisions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dataset_revisions_dataset_revision` ON `dataset_revisions` (`dataset_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_dataset_revisions_user_created` ON `dataset_revisions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_test_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sample_id` text NOT NULL,
	`schema_version` text DEFAULT 'V0.2' NOT NULL,
	`name` text NOT NULL,
	`test_type` text NOT NULL,
	`source_lab` text NOT NULL,
	`equipment_id` text NOT NULL,
	`operator` text NOT NULL,
	`test_started_at` text NOT NULL,
	`test_ended_at` text NOT NULL,
	`file_name` text NOT NULL,
	`storage_uri` text,
	`checksum_sha256` text,
	`row_count` integer,
	`unit_schema` text NOT NULL,
	`status` text DEFAULT 'registered' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `cell_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sample_id`) REFERENCES `cell_samples`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_test_datasets_status" CHECK("__new_test_datasets"."status" in ('registered', 'validated', 'rejected'))
);
--> statement-breakpoint
INSERT INTO `__new_test_datasets`("id", "user_id", "product_id", "sample_id", "schema_version", "name", "test_type", "source_lab", "equipment_id", "operator", "test_started_at", "test_ended_at", "file_name", "storage_uri", "checksum_sha256", "row_count", "unit_schema", "status", "created_at") SELECT "id", "user_id", "product_id", "sample_id", "schema_version", "name", "test_type", "source_lab", "equipment_id", "operator", "test_started_at", "test_ended_at", "file_name", "storage_uri", "checksum_sha256", "row_count", "unit_schema", "status", "created_at" FROM `test_datasets`;--> statement-breakpoint
DROP TABLE `test_datasets`;--> statement-breakpoint
ALTER TABLE `__new_test_datasets` RENAME TO `test_datasets`;--> statement-breakpoint
CREATE INDEX `idx_test_datasets_product_created` ON `test_datasets` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_test_datasets_user_created` ON `test_datasets` (`user_id`,`created_at`);