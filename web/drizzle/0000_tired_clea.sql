CREATE TABLE `simulations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`chemistry` text DEFAULT 'LFP' NOT NULL,
	`horizon_years` integer NOT NULL,
	`cycles_per_day` real NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`end_soh` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
