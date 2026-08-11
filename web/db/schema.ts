import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Persistence contract for the control plane. See `docs/data-model.md` for the
 * rationale, the write-ownership rules, and the migration from the V0.1 single
 * `simulations` table.
 */

export const PRODUCT_STATUSES = ["draft", "under_review", "released", "retired"] as const;
export const DATASET_STATUSES = ["registered", "validated", "rejected"] as const;
export const VALIDATION_STATUSES = ["pending", "pass", "warning", "reject"] as const;
export const SCENARIO_STATUSES = ["draft", "released", "superseded"] as const;
export const CALIBRATION_STATUSES = ["draft", "under_review", "approved", "rejected", "superseded"] as const;
export const ENGINEERING_REVIEW_DECISIONS = ["approved", "changes_requested", "rejected"] as const;
export const VALIDATION_POLICY_STATUSES = ["draft", "approved", "retired"] as const;

/** Product master data. Released records are immutable; revisions create a new row. */
export const cellProducts = sqliteTable("cell_products", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  chemistry: text("chemistry").notNull().default("LFP"),
  nominalCapacityAh: real("nominal_capacity_ah").notNull(),
  nominalVoltageV: real("nominal_voltage_v").notNull(),
  revision: text("revision").notNull(),
  status: text("status", { enum: PRODUCT_STATUSES }).notNull().default("draft"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_cell_products_user_created").on(table.userId, table.createdAt),
  uniqueIndex("uq_cell_products_owner_make_model_revision").on(table.userId, table.manufacturer, table.model, table.revision),
  check("ck_cell_products_status", sql`${table.status} in ('draft', 'under_review', 'released', 'retired')`),
]);

/** A physical test article. Its identity is stable across multiple test packages. */
export const cellSamples = sqliteTable("cell_samples", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull().references(() => cellProducts.id),
  sampleCode: text("sample_code").notNull(),
  batchCode: text("batch_code").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_cell_samples_owner_code").on(table.userId, table.sampleCode),
  index("idx_cell_samples_product").on(table.productId),
]);

/** Traceable metadata for one uploaded test package; the source file lives in object storage. */
export const testDatasets = sqliteTable("test_datasets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull().references(() => cellProducts.id),
  sampleId: text("sample_id").notNull().references(() => cellSamples.id),
  schemaVersion: text("schema_version").notNull().default("V0.2"),
  name: text("name").notNull(),
  testType: text("test_type").notNull(),
  sourceLab: text("source_lab").notNull(),
  equipmentId: text("equipment_id").notNull(),
  operator: text("operator").notNull(),
  testStartedAt: text("test_started_at").notNull(),
  testEndedAt: text("test_ended_at").notNull(),
  fileName: text("file_name").notNull(),
  sourceContentType: text("source_content_type"),
  byteCount: integer("byte_count"),
  storageUri: text("storage_uri"),
  checksumSha256: text("checksum_sha256"),
  rowCount: integer("row_count"),
  sourceColumnsJson: text("source_columns_json"),
  unitSchema: text("unit_schema").notNull(),
  status: text("status", { enum: DATASET_STATUSES }).notNull().default("registered"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_test_datasets_product_created").on(table.productId, table.createdAt),
  index("idx_test_datasets_user_created").on(table.userId, table.createdAt),
  uniqueIndex("uq_test_datasets_owner_idempotency").on(table.userId, table.idempotencyKey),
  check("ck_test_datasets_status", sql`${table.status} in ('registered', 'validated', 'rejected')`),
]);

/** Reproducible mapping/cleaning output derived from immutable source bytes. */
export const datasetRevisions = sqliteTable("dataset_revisions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  datasetId: text("dataset_id").notNull().references(() => testDatasets.id),
  revision: text("revision").notNull(),
  mappingVersion: text("mapping_version").notNull(),
  cleaningRuleVersion: text("cleaning_rule_version").notNull(),
  codeRevision: text("code_revision").notNull(),
  outputUri: text("output_uri"),
  outputChecksumSha256: text("output_checksum_sha256"),
  rowCount: integer("row_count"),
  validationStatus: text("validation_status", { enum: VALIDATION_STATUSES }).notNull().default("pending"),
  validationReportUri: text("validation_report_uri"),
  jobContractVersion: text("job_contract_version"),
  requestObjectKey: text("request_object_key"),
  requestChecksumSha256: text("request_checksum_sha256"),
  processingStatus: text("processing_status").notNull().default("queued"),
  attempt: integer("attempt").notNull().default(0),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
  workerId: text("worker_id"),
  error: text("error"),
  totalAbsoluteThroughputAh: real("total_absolute_throughput_ah"),
  totalEquivalentFullCycles: real("total_equivalent_full_cycles"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_dataset_revisions_dataset_revision").on(table.datasetId, table.revision),
  index("idx_dataset_revisions_user_created").on(table.userId, table.createdAt),
  index("idx_dataset_revisions_status_lease").on(table.processingStatus, table.leaseExpiresAt),
  uniqueIndex("uq_dataset_revisions_owner_idempotency").on(table.userId, table.idempotencyKey),
  check("ck_dataset_revisions_validation_status", sql`${table.validationStatus} in ('pending', 'pass', 'warning', 'reject')`),
  check("ck_dataset_revisions_processing_status", sql`${table.processingStatus} in ('queued', 'running', 'completed', 'failed', 'cancelled')`),
]);

export const datasetRevisionArtifacts = sqliteTable("dataset_revision_artifacts", {
  id: text("id").primaryKey(),
  revisionId: text("revision_id").notNull().references(() => datasetRevisions.id),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_dataset_revision_artifacts_revision").on(table.revisionId),
  uniqueIndex("uq_dataset_revision_artifacts_kind").on(table.revisionId, table.kind),
]);

export const datasetValidationPolicies = sqliteTable("dataset_validation_policies", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull().references(() => cellProducts.id),
  version: text("version").notNull(),
  voltageMinV: real("voltage_min_v").notNull(),
  voltageMaxV: real("voltage_max_v").notNull(),
  absoluteCurrentMaxA: real("absolute_current_max_a").notNull(),
  temperatureMinC: real("temperature_min_c").notNull(),
  temperatureMaxC: real("temperature_max_c").notNull(),
  irregularIntervalFraction: real("irregular_interval_fraction").notNull(),
  gapIntervalMultiplier: real("gap_interval_multiplier").notNull(),
  status: text("status", { enum: VALIDATION_POLICY_STATUSES }).notNull().default("draft"),
  approvedAt: text("approved_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_dataset_validation_policy_version").on(table.userId, table.productId, table.version),
  index("idx_dataset_validation_policy_product").on(table.productId, table.status),
  check("ck_dataset_validation_policy_status", sql`${table.status} in ('draft', 'approved', 'retired')`),
]);

/**
 * A fitted model plus the range it was fitted over.
 *
 * The envelope is columns, not prose, because `docs/architecture.md` section 3 requires
 * every run to be marked inside or outside it. A boundary written as a sentence cannot be
 * evaluated, which is why `runs.within_validity_envelope` has been permanently NULL: the
 * column existed with nothing able to compute it. Dimensions follow
 * `docs/test-data-import-and-quality-spec.md` section 7.
 *
 * Nullable bounds mean "this calibration does not constrain that dimension", which is not
 * the same as a bound of zero. `web/lib/calibrations.ts` treats an absent bound as
 * unconstrained and an absent scenario input as unevaluatable -- never as a pass.
 */
export const calibrations = sqliteTable("calibrations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull().references(() => cellProducts.id),
  /** Identity carried by the fitted artifact; separate from this internal row id. */
  artifactCalibrationId: text("artifact_calibration_id"),
  /** Fitted artifact identity, carried into every result produced with it. */
  modelVersion: text("model_version").notNull(),
  codeRevision: text("code_revision").notNull(),
  schemaVersion: text("schema_version").notNull().default("V0.2"),
  artifactObjectKey: text("artifact_object_key"),
  artifactChecksumSha256: text("artifact_checksum_sha256"),
  artifactSizeBytes: integer("artifact_size_bytes"),
  approvalEligible: integer("approval_eligible"),
  /** Reported fit error against the input revisions. Null until the fit has been scored. */
  fitError: real("fit_error"),
  cellTemperatureMinC: real("cell_temperature_min_c"),
  cellTemperatureMaxC: real("cell_temperature_max_c"),
  chargeRateMinC: real("charge_rate_min_c"),
  chargeRateMaxC: real("charge_rate_max_c"),
  dischargeRateMinC: real("discharge_rate_min_c"),
  dischargeRateMaxC: real("discharge_rate_max_c"),
  depthOfDischargeMin: real("depth_of_discharge_min"),
  depthOfDischargeMax: real("depth_of_discharge_max"),
  socMin: real("soc_min"),
  socMax: real("soc_max"),
  /** Mean-SOC envelope used by the reduced-order calibration; not an SOC window. */
  meanSocMin: real("mean_soc_min"),
  meanSocMax: real("mean_soc_max"),
  maxCalendarDays: real("max_calendar_days"),
  maxCycles: real("max_cycles"),
  maxEquivalentFullCycles: real("max_equivalent_full_cycles"),
  maxAbsoluteThroughputAh: real("max_absolute_throughput_ah"),
  status: text("status", { enum: CALIBRATION_STATUSES }).notNull().default("draft"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_calibrations_product_created").on(table.productId, table.createdAt),
  index("idx_calibrations_user_created").on(table.userId, table.createdAt),
  uniqueIndex("uq_calibrations_owner_artifact_checksum").on(
    table.userId,
    table.artifactChecksumSha256,
  ),
  uniqueIndex("uq_calibrations_owner_artifact_id").on(
    table.userId,
    table.artifactCalibrationId,
  ),
  check(
    "ck_calibrations_status",
    sql`${table.status} in ('draft', 'under_review', 'approved', 'rejected', 'superseded')`,
  ),
]);

/**
 * Which dataset revisions a calibration was fitted against.
 *
 * A join table rather than a list packed into one column: the evidence chain is the point,
 * and a JSON blob of ids carries no foreign key, so a revision could be deleted or renamed
 * out from under an approved calibration with nothing to stop it.
 */
export const calibrationInputs = sqliteTable("calibration_inputs", {
  calibrationId: text("calibration_id").notNull().references(() => calibrations.id),
  datasetRevisionId: text("dataset_revision_id").notNull().references(() => datasetRevisions.id),
}, (table) => [
  uniqueIndex("uq_calibration_inputs_pair").on(table.calibrationId, table.datasetRevisionId),
  index("idx_calibration_inputs_revision").on(table.datasetRevisionId),
]);

/**
 * A named, versioned duty cycle that results are meant to be compared across.
 *
 * `code` is opaque and `version` is monotonic within it. The parameters live in columns
 * and are deliberately not encoded into the code: a label like `ESS-STD-25C-1CPD-90DOD`
 * stops being true the moment a later version changes the SOC window, and a name that
 * lies is worse than one that says nothing.
 *
 * Rows are append-only. There is no update path, and `uq_standard_scenarios_owner_code_version`
 * makes re-registering an existing version fail rather than silently redefine what an
 * already-approved result was run against.
 *
 * Ranges match `contracts/models.py::ScenarioInput`, which is the single source of truth
 * for what the compute plane will accept. See `web/lib/scenarios.ts`.
 */
export const standardScenarios = sqliteTable("standard_scenarios", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Stable identifier for the scenario family, e.g. `ESS-STD-BASELINE`. */
  code: text("code").notNull(),
  /** Monotonic within `code`. A changed definition is a new version, never an edit. */
  version: integer("version").notNull(),
  name: text("name").notNull(),
  /** Null on legacy V0.1 rows, which remain visible but are not executable. */
  codeRevision: text("code_revision"),
  ambientTemperatureC: real("ambient_temperature_c").notNull(),
  cellTemperatureC: real("cell_temperature_c"),
  cyclesPerDay: real("cycles_per_day").notNull(),
  operatingAvailabilityFraction: real("operating_availability_fraction"),
  maxChargeCRate: real("max_charge_c_rate"),
  maxDischargeCRate: real("max_discharge_c_rate"),
  depthOfDischarge: real("depth_of_discharge").notNull(),
  /**
   * Operating SOC window. Stored explicitly because DoD alone does not locate it.
   *
   * This is control-plane metadata: `ScenarioInput` has no SOC window, so execution cannot
   * consume it today. It is used to judge a duty cycle against a calibration envelope. The
   * contract gap is real and is raised on the review thread rather than papered over.
   */
  socWindowMin: real("soc_window_min").notNull(),
  socWindowMax: real("soc_window_max").notNull(),
  horizonYears: integer("horizon_years").notNull(),
  /**
   * Carried so the record is a complete execution template.
   *
   * `ScenarioInput` requires both, so a standard scenario lacking them could not construct
   * an executable job without inventing values at submission time -- and an invented input
   * is exactly what must never reach a result that claims to be reproducible.
   */
  initialSoc: real("initial_soc").notNull(),
  endOfLifeFraction: real("end_of_life_fraction").notNull(),
  status: text("status", { enum: SCENARIO_STATUSES }).notNull().default("draft"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_standard_scenarios_owner_code_version").on(table.userId, table.code, table.version),
  index("idx_standard_scenarios_user_created").on(table.userId, table.createdAt),
  check("ck_standard_scenarios_status", sql`${table.status} in ('draft', 'released', 'superseded')`),
]);

/** What is being studied. Never mutated in place: an edit produces a new row. */
export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  chemistry: text("chemistry").notNull().default("LFP"),
  /** Which approved cell parameter set the study assumes. Null until `cell_database` publishes one. */
  cellParamSetVersion: text("cell_param_set_version"),
  /**
   * The standard scenario this study instantiates, when it instantiates one.
   *
   * Null for ad-hoc exploratory studies, which stay allowed. Only the row id is stored:
   * the version belongs to the referenced row, and duplicating it here would let the two
   * disagree — the same failure mode that put `batch_code` on one table only (#12 F2).
   */
  standardScenarioId: text("standard_scenario_id").references(() => standardScenarios.id),
  horizonYears: integer("horizon_years").notNull(),
  cyclesPerDay: real("cycles_per_day").notNull(),
  depthOfDischarge: real("depth_of_discharge").notNull().default(0.9),
  ambientTemperatureC: real("ambient_temperature_c").notNull().default(25),
  initialSoc: real("initial_soc").notNull().default(0.5),
  eolFraction: real("eol_fraction").notNull().default(0.8),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_scenarios_user_created").on(table.userId, table.createdAt),
]);

/** One execution of one scenario under one model version. */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id),
  /** Denormalised from the scenario so the ownership filter and its index stay single-table. */
  userId: text("user_id").notNull(),
  /** Makes a retried submission safe. Unique per user; null for submissions that did not supply one. */
  idempotencyKey: text("idempotency_key"),
  /**
   * Permanent provenance marker, not a status. A row produced by the demonstrator
   * progress engine stays `demo` for life and is never promoted to `pybamm-spme`.
   * The vocabulary is `contracts/models.py`; `web/lib/runs.ts` derives its type from the
   * generated contract so the two cannot drift apart again.
   */
  engine: text("engine").notNull().default("demo"),
  modelVersion: text("model_version"),
  codeRevision: text("code_revision"),
  /** Job contract and private R2 payload used by a real compute worker. */
  jobContractVersion: text("job_contract_version"),
  payloadObjectKey: text("payload_object_key"),
  payloadChecksumSha256: text("payload_checksum_sha256"),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  /** Summary scalar only. The full SOH series lives in `run_artifacts`. */
  endSoh: real("end_soh"),
  attempt: integer("attempt").notNull().default(0),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
  workerId: text("worker_id"),
  checkpointUri: text("checkpoint_uri"),
  error: text("error"),
  /** 0/1. Whether the duty cycle stayed inside the model's calibrated range. */
  withinValidityEnvelope: integer("within_validity_envelope"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_runs_user_created").on(table.userId, table.createdAt),
  index("idx_runs_scenario").on(table.scenarioId),
  index("idx_runs_claim").on(table.status, table.leaseExpiresAt),
  uniqueIndex("uq_runs_user_idempotency").on(table.userId, table.idempotencyKey),
]);

/** Pointers and checksums for outputs that live in object storage. */
export const runArtifacts = sqliteTable("run_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  checksum: text("checksum"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_run_artifacts_run").on(table.runId),
  uniqueIndex("uq_run_artifacts_run_kind").on(table.runId, table.kind),
]);

/** Append-only human decisions over one exact completed standard-study evidence set. */
export const engineeringReviews = sqliteTable("engineering_reviews", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  userId: text("user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  decision: text("decision", { enum: ENGINEERING_REVIEW_DECISIONS }).notNull(),
  comment: text("comment").notNull(),
  reviewerId: text("reviewer_id").notNull(),
  reviewerEmail: text("reviewer_email"),
  manifestChecksumSha256: text("manifest_checksum_sha256").notNull(),
  sohResultChecksumSha256: text("soh_result_checksum_sha256").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_engineering_reviews_run_created").on(table.runId, table.createdAt),
  index("idx_engineering_reviews_user_created").on(table.userId, table.createdAt),
  uniqueIndex("uq_engineering_reviews_user_idempotency").on(table.userId, table.idempotencyKey),
  check(
    "ck_engineering_reviews_decision",
    sql`${table.decision} in ('approved', 'changes_requested', 'rejected')`,
  ),
]);

/** Independent compute jobs that compare two immutable standard-study results. */
export const studyComparisons = sqliteTable("study_comparisons", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  baselineRunId: text("baseline_run_id").notNull().references(() => runs.id),
  currentRunId: text("current_run_id").notNull().references(() => runs.id),
  comparisonVersion: text("comparison_version").notNull(),
  codeRevision: text("code_revision").notNull(),
  jobContractVersion: text("job_contract_version").notNull(),
  payloadObjectKey: text("payload_object_key").notNull(),
  payloadChecksumSha256: text("payload_checksum_sha256").notNull(),
  status: text("status").notNull().default("queued"),
  attempt: integer("attempt").notNull().default(0),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
  workerId: text("worker_id"),
  error: text("error"),
  finalCapacityDeltaFraction: real("final_capacity_delta_fraction"),
  maximumAbsoluteCapacityDeltaFraction: real("maximum_absolute_capacity_delta_fraction"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_study_comparisons_user_created").on(table.userId, table.createdAt),
  index("idx_study_comparisons_claim").on(table.status, table.leaseExpiresAt),
  uniqueIndex("uq_study_comparisons_user_idempotency").on(table.userId, table.idempotencyKey),
  check(
    "ck_study_comparisons_status",
    sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
  ),
  check(
    "ck_study_comparisons_distinct_runs",
    sql`${table.baselineRunId} <> ${table.currentRunId}`,
  ),
]);

export const comparisonArtifacts = sqliteTable("comparison_artifacts", {
  id: text("id").primaryKey(),
  comparisonId: text("comparison_id").notNull().references(() => studyComparisons.id),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_comparison_artifacts_comparison").on(table.comparisonId),
  uniqueIndex("uq_comparison_artifacts_kind").on(table.comparisonId, table.kind),
]);
