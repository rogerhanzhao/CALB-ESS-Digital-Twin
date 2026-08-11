ALTER TABLE `calibrations` ADD `artifact_calibration_id` text;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `schema_version` text DEFAULT 'V0.2' NOT NULL;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `artifact_object_key` text;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `artifact_checksum_sha256` text;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `artifact_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `approval_eligible` integer;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `mean_soc_min` real;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `mean_soc_max` real;--> statement-breakpoint
ALTER TABLE `calibrations` ADD `max_absolute_throughput_ah` real;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calibrations_owner_artifact_checksum` ON `calibrations` (`user_id`,`artifact_checksum_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calibrations_owner_artifact_id` ON `calibrations` (`user_id`,`artifact_calibration_id`);--> statement-breakpoint
ALTER TABLE `standard_scenarios` ADD `code_revision` text;--> statement-breakpoint
ALTER TABLE `standard_scenarios` ADD `cell_temperature_c` real;--> statement-breakpoint
ALTER TABLE `standard_scenarios` ADD `operating_availability_fraction` real;--> statement-breakpoint
ALTER TABLE `standard_scenarios` ADD `max_charge_c_rate` real;--> statement-breakpoint
ALTER TABLE `standard_scenarios` ADD `max_discharge_c_rate` real;