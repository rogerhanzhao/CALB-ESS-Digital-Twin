# Data model

The control-plane persistence contract. Introduced by the V0.1 design review, which found that a
single `simulations` table could not satisfy the auditability requirements the project had
already written down. See `docs/design-review.md` §P1-2.

## Why three tables

The V0.1 schema mixed the definition of a study with the record of one execution of it, and
compressed the result to a single scalar. That makes the platform's central use case —
*re-run the same scenario under a newer model version and compare* — impossible to express.

| Table | Responsibility | Lifetime |
|---|---|---|
| `scenarios` | What is being studied. Reusable, versioned input definition. | Long-lived; edited by creating a new row |
| `runs` | One execution of one scenario under one model version. | Immutable once terminal |
| `run_artifacts` | Where the outputs live. Metadata and checksums only. | Follows its run |

A scenario has many runs. A run has many artifacts. Comparing model versions means selecting
runs that share a `scenario_id` and differ in `model_version`.

## Raw test evidence (V0.2)

`test_datasets` identifies one immutable laboratory source package and its physical product,
sample/batch, equipment, operator and test period. `storage_uri`, server-computed
`checksum_sha256`, `byte_count`, `source_content_type` and `row_count` bind that row to private R2
bytes; raw content is never stored in D1. `(user_id, idempotency_key)` prevents a browser retry from
creating a second evidence record. The authenticated download endpoint re-hashes the object before
serving it. A `registered` source is not calibration evidence until a separately versioned
`dataset_revisions` row records mapping, cleaning output and validation disposition.

## Calibration evidence registry (V0.2)

`calibrations` now stores the identity and queryable validity envelope of an immutable fitted
artifact. The exact canonical JSON lives in private R2; `artifact_object_key`,
`artifact_checksum_sha256`, and `artifact_size_bytes` bind the D1 record to those bytes.
`calibration_inputs` links each calibration to the validated dataset revisions used for fitting,
so approval evidence cannot be represented as an unchecked JSON list.

Reduced-order model bounds `mean_soc_min` / `mean_soc_max` are intentionally separate from the
legacy SOC-window bounds `soc_min` / `soc_max`. See
`docs/calibration-artifact-registry.md` for the registration and approval gates.

`standard_scenarios` V0.2 rows also carry `code_revision`, `cell_temperature_c`, operating
availability, and charge/discharge C-rate limits. The fields are nullable only to preserve
historical V0.1 rows; an incomplete legacy row cannot transition to `released`.

## `scenarios`

Input definition. Never mutated in place — an edit produces a new row, so every run keeps
pointing at exactly the inputs it used.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID |
| `user_id` | text | Owner; from `oai-authenticated-user-id` |
| `name` | text | Display name |
| `chemistry` | text | Enumerated; validated against a whitelist |
| `cell_param_set_version` | text | Which approved parameter set the study assumes |
| `horizon_years` | integer | Study length |
| `cycles_per_day` | real | Duty cycle |
| `depth_of_discharge` | real | Duty cycle |
| `ambient_temperature_c` | real | Operating condition |
| `initial_soc` | real | Operating condition |
| `eol_fraction` | real | End-of-life threshold |
| `created_at` | text | ISO-8601 |

`cell_param_set_version` is the field that makes a scenario reproducible. Without it a scenario
only describes a duty cycle, not the cell it was applied to.

## `runs`

One execution. Carries the provenance the architecture document requires and the job-execution
state `docs/deployment-and-capacity.md` requires.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID |
| `scenario_id` | text FK | → `scenarios.id` |
| `user_id` | text | Denormalised for the ownership filter and its index |
| `idempotency_key` | text | Unique per user; makes retried submissions safe |
| `engine` | text | `demo` \| `pybamm`. See below |
| `model_version` | text | Which SOH model produced this |
| `code_revision` | text | Git revision of the compute worker |
| `status` | text | `queued` \| `running` \| `completed` \| `failed` \| `cancelled` |
| `progress` | integer | 0–100, written only by the owning worker |
| `end_soh` | real | Summary scalar; full series lives in artifacts |
| `attempt` | integer | Retry count |
| `lease_expires_at` | text | Lease expiry; another worker may claim after it passes |
| `heartbeat_at` | text | Last worker heartbeat |
| `checkpoint_uri` | text | Resume point in object storage |
| `error` | text | Failure detail |
| `within_validity_envelope` | integer | 0/1. Whether the duty cycle stayed inside the model's calibrated range |
| `created_at` / `updated_at` | text | ISO-8601 |

`engine` is a permanent provenance marker, not a status. A row written by the demonstrator
progress engine carries `engine = 'demo'` for the rest of its life and is never promoted to
`pybamm`. This is what makes demonstrator output distinguishable after a real compute worker is
connected — the problem identified in `docs/design-review.md` §P0-2.

`within_validity_envelope = 0` means the run left the range the model was calibrated over. Such
a run may be inspected but must not support a warranty conclusion (`docs/architecture.md` §3).

### Indexes

- `(user_id, created_at)` — the list query.
- `(scenario_id)` — model-version comparison across runs of one scenario.
- `(status, lease_expires_at)` — worker claim and expired-lease reclamation.
- `(user_id, idempotency_key)` unique — duplicate submission suppression.

The V0.1 single-column index on `status` is dropped; it did not match any query the application
issues.

## `run_artifacts`

Large outputs live in object storage. The database keeps only the pointer and the checksum, so
that an artifact cannot be silently substituted.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID |
| `run_id` | text FK | → `runs.id` |
| `kind` | text | `soh_series` \| `throughput_series` \| `resistance_series` \| `report` \| `audit_bundle` |
| `uri` | text | Object-storage location |
| `content_type` | text | MIME type |
| `size_bytes` | integer | |
| `checksum` | text | Content hash |
| `created_at` | text | ISO-8601 |

The `audit_bundle` kind is the immutable record required for commercial warranty runs: inputs,
model code revision, parameter-set revision, environment, logs, and output checksums.

The hosted standard-study worker currently registers four exact JSON artifacts:
`study-request.json`, `scenario-exposure.json`, `soh-result.json`, and `manifest.json`. Client
applications receive an owner-authorized application URL, not the R2 URI. The read path verifies
the stored byte count and SHA-256 again before returning evidence.

## `engineering_reviews`

Append-only human decisions over completed standard-study evidence. Execution state remains on
`runs`; review state is deliberately separate. Each decision stores the authenticated reviewer,
substantive comment, timestamp, idempotency key, and the exact manifest and SOH-result checksums
reviewed. The latest row is the current decision, while prior requests for changes or rejections
remain auditable. See `docs/engineering-review-workflow.md` for the approval gate and warranty
boundary.

## Write ownership

Exactly one writer per field, to prevent the read-path/worker race found in the review:

| Field group | Written by |
|---|---|
| `scenarios.*` | Control plane, on creation |
| `runs.progress`, `status`, `end_soh`, `attempt`, `heartbeat_at`, `checkpoint_uri`, `error` | The compute worker holding the lease |
| `runs.status = 'cancelled'` | Control plane, on user request |
| `run_artifacts.*` | The compute worker, on upload |

Read paths never write. `GET /api/simulations` is strictly read-only; any progress animation for
demonstrator rows is derived at render time and not persisted.

## Migration from V0.1

`drizzle/0002_split_scenarios_runs_artifacts.sql` creates the three tables, back-fills them from
the V0.1 `simulations` rows, and drops the old table. Back-filled rows take `engine = 'demo'`,
because every V0.1 result was produced by the demonstrator progress engine — including the
`end_soh` values, which came from a hard-coded linear expression rather than from any model.
Fields V0.1 never captured (`code_revision`, `checkpoint_uri`, and similar) are left null.
