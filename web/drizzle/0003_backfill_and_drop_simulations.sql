-- Back-fill the V0.1 `simulations` rows into the split model, then drop the old table.
--
-- Every V0.1 row was produced by the demonstrator progress engine, including its
-- `end_soh` values, which came from a hard-coded linear expression rather than from
-- any model (see docs/design-review.md P0-2). They are therefore all imported with
-- `engine = 'demo'` and can never be mistaken for real results afterwards.
--
-- Run ids are preserved so existing links keep resolving. Scenario ids are derived
-- from them. Columns V0.1 never captured are left null.
--
-- The generated statement (DROP TABLE) is retained at the end; the statements above
-- it are hand-written back-fill and must run first.

INSERT INTO `scenarios` (
	`id`, `user_id`, `name`, `chemistry`, `cell_param_set_version`,
	`horizon_years`, `cycles_per_day`, `depth_of_discharge`,
	`ambient_temperature_c`, `initial_soc`, `eol_fraction`, `created_at`
)
SELECT
	'sc-' || `id`, `user_id`, `name`, `chemistry`, NULL,
	`horizon_years`, `cycles_per_day`, 0.9,
	25, 0.5, 0.8, `created_at`
FROM `simulations`;
--> statement-breakpoint
INSERT INTO `runs` (
	`id`, `scenario_id`, `user_id`, `idempotency_key`, `engine`,
	`model_version`, `code_revision`, `status`, `progress`, `end_soh`,
	`attempt`, `lease_expires_at`, `heartbeat_at`, `checkpoint_uri`, `error`,
	`within_validity_envelope`, `created_at`, `updated_at`
)
SELECT
	`id`, 'sc-' || `id`, `user_id`, NULL, 'demo',
	NULL, NULL, `status`, `progress`, `end_soh`,
	0, NULL, NULL, NULL, NULL,
	NULL, `created_at`, `updated_at`
FROM `simulations`;
--> statement-breakpoint
DROP TABLE `simulations`;
