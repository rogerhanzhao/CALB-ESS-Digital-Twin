CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`content_type` text,
	`size_bytes` integer,
	`checksum` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_artifacts_run` ON `run_artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text,
	`engine` text DEFAULT 'demo' NOT NULL,
	`model_version` text,
	`code_revision` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`end_soh` real,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`checkpoint_uri` text,
	`error` text,
	`within_validity_envelope` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_runs_user_created` ON `runs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_scenario` ON `runs` (`scenario_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_claim` ON `runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runs_user_idempotency` ON `runs` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`chemistry` text DEFAULT 'LFP' NOT NULL,
	`cell_param_set_version` text,
	`horizon_years` integer NOT NULL,
	`cycles_per_day` real NOT NULL,
	`depth_of_discharge` real DEFAULT 0.9 NOT NULL,
	`ambient_temperature_c` real DEFAULT 25 NOT NULL,
	`initial_soc` real DEFAULT 0.5 NOT NULL,
	`eol_fraction` real DEFAULT 0.8 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scenarios_user_created` ON `scenarios` (`user_id`,`created_at`);