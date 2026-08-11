CREATE TABLE `engineering_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`decision` text NOT NULL,
	`comment` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`reviewer_email` text,
	`manifest_checksum_sha256` text NOT NULL,
	`soh_result_checksum_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_engineering_reviews_decision" CHECK("engineering_reviews"."decision" in ('approved', 'changes_requested', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_engineering_reviews_run_created` ON `engineering_reviews` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_engineering_reviews_user_created` ON `engineering_reviews` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_engineering_reviews_user_idempotency` ON `engineering_reviews` (`user_id`,`idempotency_key`);