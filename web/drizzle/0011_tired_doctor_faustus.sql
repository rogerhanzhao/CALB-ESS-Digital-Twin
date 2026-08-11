CREATE TABLE `comparison_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`comparison_id` text NOT NULL,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`comparison_id`) REFERENCES `study_comparisons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_comparison_artifacts_comparison` ON `comparison_artifacts` (`comparison_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_comparison_artifacts_kind` ON `comparison_artifacts` (`comparison_id`,`kind`);--> statement-breakpoint
CREATE TABLE `study_comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`baseline_run_id` text NOT NULL,
	`current_run_id` text NOT NULL,
	`comparison_version` text NOT NULL,
	`code_revision` text NOT NULL,
	`job_contract_version` text NOT NULL,
	`payload_object_key` text NOT NULL,
	`payload_checksum_sha256` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`worker_id` text,
	`error` text,
	`final_capacity_delta_fraction` real,
	`maximum_absolute_capacity_delta_fraction` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`baseline_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_study_comparisons_status" CHECK("study_comparisons"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ck_study_comparisons_distinct_runs" CHECK("study_comparisons"."baseline_run_id" <> "study_comparisons"."current_run_id")
);
--> statement-breakpoint
CREATE INDEX `idx_study_comparisons_user_created` ON `study_comparisons` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_study_comparisons_claim` ON `study_comparisons` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_study_comparisons_user_idempotency` ON `study_comparisons` (`user_id`,`idempotency_key`);