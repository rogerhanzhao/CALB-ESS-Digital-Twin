CREATE TABLE `dataset_revision_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `dataset_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_dataset_revision_artifacts_revision` ON `dataset_revision_artifacts` (`revision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dataset_revision_artifacts_kind` ON `dataset_revision_artifacts` (`revision_id`,`kind`);--> statement-breakpoint
CREATE TABLE `dataset_validation_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`version` text NOT NULL,
	`voltage_min_v` real NOT NULL,
	`voltage_max_v` real NOT NULL,
	`absolute_current_max_a` real NOT NULL,
	`temperature_min_c` real NOT NULL,
	`temperature_max_c` real NOT NULL,
	`irregular_interval_fraction` real NOT NULL,
	`gap_interval_multiplier` real NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `cell_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_dataset_validation_policy_status" CHECK("dataset_validation_policies"."status" in ('draft', 'approved', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dataset_validation_policy_version` ON `dataset_validation_policies` (`user_id`,`product_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_dataset_validation_policy_product` ON `dataset_validation_policies` (`product_id`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`job_contract_version` text,
	`request_object_key` text,
	`request_checksum_sha256` text,
	`processing_status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`worker_id` text,
	`error` text,
	`total_absolute_throughput_ah` real,
	`total_equivalent_full_cycles` real,
	`idempotency_key` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `test_datasets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_dataset_revisions_validation_status" CHECK("__new_dataset_revisions"."validation_status" in ('pending', 'pass', 'warning', 'reject')),
	CONSTRAINT "ck_dataset_revisions_processing_status" CHECK("__new_dataset_revisions"."processing_status" in ('queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_dataset_revisions`("id", "user_id", "dataset_id", "revision", "mapping_version", "cleaning_rule_version", "code_revision", "output_uri", "output_checksum_sha256", "row_count", "validation_status", "validation_report_uri", "job_contract_version", "request_object_key", "request_checksum_sha256", "processing_status", "attempt", "lease_expires_at", "heartbeat_at", "worker_id", "error", "total_absolute_throughput_ah", "total_equivalent_full_cycles", "idempotency_key", "created_at") SELECT "id", "user_id", "dataset_id", "revision", "mapping_version", "cleaning_rule_version", "code_revision", "output_uri", "output_checksum_sha256", "row_count", "validation_status", "validation_report_uri", NULL, NULL, NULL, 'completed', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, "created_at" FROM `dataset_revisions`;--> statement-breakpoint
DROP TABLE `dataset_revisions`;--> statement-breakpoint
ALTER TABLE `__new_dataset_revisions` RENAME TO `dataset_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dataset_revisions_dataset_revision` ON `dataset_revisions` (`dataset_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_dataset_revisions_user_created` ON `dataset_revisions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_dataset_revisions_status_lease` ON `dataset_revisions` (`processing_status`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dataset_revisions_owner_idempotency` ON `dataset_revisions` (`user_id`,`idempotency_key`);
