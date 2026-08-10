CREATE TABLE `standard_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`ambient_temperature_c` real NOT NULL,
	`cycles_per_day` real NOT NULL,
	`depth_of_discharge` real NOT NULL,
	`soc_window_min` real NOT NULL,
	`soc_window_max` real NOT NULL,
	`horizon_years` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "ck_standard_scenarios_status" CHECK("standard_scenarios"."status" in ('draft', 'released', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_standard_scenarios_owner_code_version` ON `standard_scenarios` (`user_id`,`code`,`version`);--> statement-breakpoint
CREATE INDEX `idx_standard_scenarios_user_created` ON `standard_scenarios` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `scenarios` ADD `standard_scenario_id` text REFERENCES standard_scenarios(id);