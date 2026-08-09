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
  storageUri: text("storage_uri"),
  checksumSha256: text("checksum_sha256"),
  rowCount: integer("row_count"),
  unitSchema: text("unit_schema").notNull(),
  status: text("status", { enum: DATASET_STATUSES }).notNull().default("registered"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_test_datasets_product_created").on(table.productId, table.createdAt),
  index("idx_test_datasets_user_created").on(table.userId, table.createdAt),
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
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_dataset_revisions_dataset_revision").on(table.datasetId, table.revision),
  index("idx_dataset_revisions_user_created").on(table.userId, table.createdAt),
  check("ck_dataset_revisions_validation_status", sql`${table.validationStatus} in ('pending', 'pass', 'warning', 'reject')`),
]);

/** What is being studied. Never mutated in place: an edit produces a new row. */
export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  chemistry: text("chemistry").notNull().default("LFP"),
  /** Which approved cell parameter set the study assumes. Null until `cell_database` publishes one. */
  cellParamSetVersion: text("cell_param_set_version"),
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
   * progress engine stays `demo` for life and is never promoted to `pybamm`.
   */
  engine: text("engine").notNull().default("demo"),
  modelVersion: text("model_version"),
  codeRevision: text("code_revision"),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  /** Summary scalar only. The full SOH series lives in `run_artifacts`. */
  endSoh: real("end_soh"),
  attempt: integer("attempt").notNull().default(0),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
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
]);
