# Test Data Import and Quality Specification

Status: Draft for Alex.Z acceptance and Claude cross-review  
Human-facing version: V0.2  
Concept and system direction: Alex.Z

## 1. Purpose and boundary

This specification defines how measured LFP cell data enters the platform before any PyBaMM calibration, SOH extrapolation, ESS translation, or warranty analysis is allowed.

The physical test file is evidence. A model output is not allowed to repair, replace, or silently reinterpret missing physical evidence. Import, cleaning, calibration, simulation, and approval are separate versioned stages.

V0.2 registers CSV and XLSX packages. CSV is the canonical machine-readable format. XLSX may be accepted as an operator input, but an immutable canonical CSV artifact must be produced before review.

## 2. Version chain

```text
Product revision
  └─ Sample / batch identity
      └─ Test dataset (immutable source bytes + SHA-256)
          └─ Dataset revision (cleaning/mapping rules + derived artifact)
              └─ Calibration version (parameters + validity envelope)
                  └─ Standard scenario version
                      └─ Run result
                          └─ Result version (review and approval state)
```

Rules:

1. A source dataset is append-only. Re-uploading changed bytes creates a new dataset.
2. Cleaning the same source with different rules creates a new dataset revision; it never overwrites the source.
3. Calibrations reference dataset revisions, not raw datasets.
4. Approved result versions are immutable. A rerun creates a successor version.
5. Every artifact stores a SHA-256 checksum and a content type.

## 3. Import package

An import consists of a manifest plus one or more data files.

### 3.1 Required manifest fields

| Field | Meaning | Rule |
|---|---|---|
| `schema_version` | Import contract version | Required; `V0.2` for this specification |
| `product_id` | Registered product revision | Required |
| `sample_id` | Physical sample identity | Required; must not be reused across cells |
| `batch_code` | Manufacturing/sample batch | Required |
| `test_type` | Test family | `cycle_aging`, `calendar_aging`, `hppc`, or `temperature` |
| `source_lab` | Test owner or laboratory | Required |
| `equipment_id` | Test channel/equipment identity | Required |
| `test_started_at` | Physical test start | ISO 8601 with timezone |
| `test_ended_at` | Physical test end | ISO 8601 with timezone |
| `file_name` | Original file name | Required |
| `file_sha256` | Source-byte checksum | 64 hexadecimal characters |
| `operator` | Responsible operator identity | Required for review; not necessarily public |
| `notes` | Exceptions and deviations | Optional; cannot replace structured fields |

### 3.2 Canonical measurement columns

CSV uses UTF-8, a header row, comma delimiter, dot decimal separator, and ISO 8601 timestamps. Units are encoded in the manifest or a versioned column mapping, never guessed from magnitudes.

| Column | Canonical unit | Required |
|---|---:|---|
| `timestamp` | ISO 8601 | All time-series data |
| `elapsed_time_s` | s | All time-series data |
| `voltage_v` | V | All electrical tests |
| `current_a` | A | All electrical tests; charge positive, discharge negative |
| `cell_temperature_c` | °C | All tests |
| `ambient_temperature_c` | °C | All tests |
| `capacity_ah` | Ah | Cycle and capacity tests |
| `energy_wh` | Wh | Cycle tests when available |
| `soc_fraction` | 0–1 | When independently available; estimated SOC must identify its method |
| `cycle_index` | integer | Cycle ageing |
| `step_index` | integer | Cycle ageing and HPPC |
| `rest_duration_s` | s | HPPC and relaxation segments when applicable |

Sign convention is fixed platform-wide: charge current is positive and discharge current is negative. A source using another convention must declare the mapping in its dataset revision.

## 4. Universal validation gates

Validation emits `pass`, `warning`, or `reject`. A rejected dataset cannot enter calibration.

### 4.1 Structural rejection

- File cannot be parsed deterministically.
- Required manifest field or required column is missing.
- Timestamp is invalid, duplicated within a channel, or decreases.
- Numeric field contains non-numeric values after declared missing-value handling.
- Units are missing, ambiguous, or incompatible with the canonical quantity.
- File checksum does not match the registered checksum.
- Product, sample, or test-type reference does not exist.

### 4.2 Physical plausibility rejection

- Voltage is outside the declared equipment range or product safety boundary.
- Absolute current exceeds the declared channel or test-plan limit.
- Temperature is outside the declared chamber/sensor range.
- Time interval is zero or negative.
- Cycle or step index decreases unexpectedly.
- A data transformation changes source values without a recorded rule and revision.

Product-specific voltage, current, and temperature limits must come from an approved product/test-plan record. V0.2 must not hard-code confidential CALB limits into generic application code.

### 4.3 Warnings requiring reviewer disposition

- Sampling interval is irregular but timestamps remain valid.
- Short gaps exist within a declared tolerance.
- Sensor values are flat for a suspicious duration.
- Capacity or energy balance differs beyond the test-plan warning threshold.
- Chamber and cell temperatures diverge beyond the test-plan warning threshold.
- Equipment calibration expires within the test period or cannot be verified electronically.

Warnings are never silently cleared. A reviewer must accept, reject, or request a new dataset revision.

## 5. Test-specific quality rules

### 5.1 Cycle ageing

Required: cycle index, step index, time, voltage, current, cell temperature, ambient temperature, and per-cycle capacity.

- Each analysed cycle must have identifiable charge, rest, discharge, and rest segments according to its test plan.
- Capacity integration must use timestamps and current; reported tester capacity is retained separately for reconciliation.
- Missing full-capacity reference cycles are a warning or rejection according to the calibration method.
- Cycle count, throughput, charge capacity, discharge capacity, Coulombic efficiency, and energy efficiency are derived per dataset revision.
- Partial cycles must be labelled and cannot be silently counted as full equivalent cycles.

### 5.2 Calendar ageing

Required: storage start/end, target SOC, storage temperature, check-up timestamps, voltage, capacity-check data, and temperature history.

- Storage duration must be derived from timestamps, not operator-entered day counts alone.
- Temperature excursions and SOC-reset/check-up events are retained as events.
- Calendar exposure and check-up cycling throughput are reported separately.
- A dataset without traceable storage temperature history cannot support a calibrated temperature-acceleration claim.

### 5.3 HPPC

Required: SOC point, pulse direction, pulse current, pulse duration, pre-pulse rest, voltage, current, temperature, and time.

- Pulse start/end must be identifiable from measured current, not only schedule labels.
- Resistance calculation windows are versioned parameters of the dataset revision.
- Insufficient rest or unstable pre-pulse voltage is flagged.
- Charge and discharge resistance remain separate quantities unless a documented reduction method combines them.

### 5.4 Temperature characteristics

Required: chamber setpoint, measured ambient temperature, cell temperature, stabilization duration, voltage, current, and time.

- Stabilization acceptance uses measured temperatures and a versioned tolerance/duration rule.
- Chamber setpoint alone is not evidence of cell temperature.
- Results outside the calibration validity range may be retained as evidence but cannot silently expand the approved model envelope.

## 6. Cleaning and dataset revisions

Every dataset revision records:

- source dataset ID and source checksum;
- mapping specification version;
- cleaning-rule version and code revision;
- excluded row ranges with reason codes;
- unit conversions with source and target units;
- current-sign conversion, if applied;
- resampling/interpolation method and parameters;
- derived-column definitions;
- output artifact URI, row count, and SHA-256;
- validation report artifact and reviewer disposition.

The source file remains readable and unchanged. Cleaning output must be reproducible from the source plus the recorded rules.

## 7. Calibration validity envelope

A calibration envelope is structured data, not prose. At minimum it contains:

| Dimension | Representation |
|---|---|
| Cell temperature | min/max °C |
| Charge rate | min/max C-rate |
| Discharge rate | min/max C-rate |
| DoD | min/max fraction |
| SOC window | min/max fraction |
| Calendar exposure | maximum duration |
| Cycle exposure | maximum cycles and equivalent full cycles |
| Chemistry/product revision | exact references |

A run outside any approved dimension sets `within_validity_envelope = false`. It may be exploratory, but it cannot support an approved warranty conclusion without an explicit exception review.

## 8. Result provenance and approval

Each result version carries an immutable provenance tuple:

```text
(product_revision, dataset_revision_ids, calibration_version,
 standard_scenario_version, code_revision, dependency_lock_checksum,
 container_image_digest, engine, model_version)
```

Execution status (`completed`, `failed`, `cancelled`) and approval status (`draft`, `under_review`, `approved`, `superseded`, `rejected`) are independent state machines.

Any approved result must be produced in a frozen environment identified by container image digest and dependency lock checksum. Local exploratory runs may omit approval but must remain visibly distinguishable.

## 9. V0.2 implementation decision

The tables introduced in Draft PR #12 are provisional. Before merging:

1. split immutable `test_datasets` from versioned `dataset_revisions`;
2. add sample identity and equipment/test-period provenance;
3. represent unit mappings and validation reports as versioned artifacts;
4. ensure calibrations reference dataset revisions;
5. keep raw file content out of D1 and store only metadata/checksums/object references;
6. obtain Alex.Z acceptance of the first import template and quality thresholds.

Numeric product safety limits and warning tolerances remain test-plan configuration. They must not be invented in this generic specification.

### V0.2 executable intake slice

The Python package now provides `calb-validate-test-data` as the first executable intake gate. It
verifies the immutable source checksum, applies only declared and supported unit/sign conversions,
checks test-type column requirements, enforces caller-supplied product/test-plan bounds, and emits a
versioned JSON validation report plus canonical CSV when the outcome is not `reject`.

This slice does not yet approve a dataset revision. Equipment/product registry lookup, warning
disposition, excluded-row cleaning revisions, test-specific derived metrics, and control-plane
artifact registration remain separate follow-up capabilities. The template under
`examples/test-data-import/` is pending Alex.Z acceptance with the first real test-plan mapping and
must not be treated as an approved CALB limit set.
