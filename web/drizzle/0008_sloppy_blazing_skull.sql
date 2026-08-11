ALTER TABLE `runs` ADD `job_contract_version` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `payload_object_key` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `payload_checksum_sha256` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `worker_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_run_artifacts_run_kind` ON `run_artifacts` (`run_id`,`kind`);