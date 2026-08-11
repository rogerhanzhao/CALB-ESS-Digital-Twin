CREATE TABLE `calibration_inputs` (
	`calibration_id` text NOT NULL,
	`dataset_revision_id` text NOT NULL,
	FOREIGN KEY (`calibration_id`) REFERENCES `calibrations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_revision_id`) REFERENCES `dataset_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calibration_inputs_pair` ON `calibration_inputs` (`calibration_id`,`dataset_revision_id`);--> statement-breakpoint
CREATE INDEX `idx_calibration_inputs_revision` ON `calibration_inputs` (`dataset_revision_id`);--> statement-breakpoint
CREATE TABLE `calibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`model_version` text NOT NULL,
	`code_revision` text NOT NULL,
	`fit_error` real,
	`temperature_min_c` real,
	`temperature_max_c` real,
	`charge_rate_min_c` real,
	`charge_rate_max_c` real,
	`discharge_rate_min_c` real,
	`discharge_rate_max_c` real,
	`depth_of_discharge_min` real,
	`depth_of_discharge_max` real,
	`soc_min` real,
	`soc_max` real,
	`max_calendar_days` real,
	`max_cycles` real,
	`max_equivalent_full_cycles` real,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `cell_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_calibrations_status" CHECK("calibrations"."status" in ('draft', 'under_review', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX `idx_calibrations_product_created` ON `calibrations` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calibrations_user_created` ON `calibrations` (`user_id`,`created_at`);