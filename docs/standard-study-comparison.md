# Standard study result comparison

Status: engineering baseline for cross-review

Human-facing version: V0.2

Concept and system direction: Alex.Z

## Purpose

When new physical test data produces a new calibration and standard-study result, this component
compares the new result with the prior version at every annual point. It preserves which dataset
revisions and calibration versions produced each side.

## Like-for-like gate

A model-update comparison is accepted only when both studies use the same product revision,
standard-scenario version, operating conditions, calendar axis, and exposure trajectory. Elapsed
days, Ah throughput, cycle count, and EFC each use their own explicitly configured absolute
tolerance; one unitless tolerance is never reused across unlike quantities. A changed duty cycle is
rejected instead of being mislabeled as a change in the SOH model.

Baseline/current study and result versions must differ. Each manifest must match its accompanying
artifact before comparison begins. The CLI reads both immutable bundle directories directly,
verifies the exact byte count and SHA-256 of every evidence file, and then cross-checks the
normalized request, exposure, SOH result, and manifest provenance. A modified or incomplete bundle
is rejected.

## Output

Each annual point records:

- old and new capacity fractions and signed delta;
- `improved`, `degraded`, or `unchanged`, using a method-supplied tolerance;
- validity-envelope transition and physical-prediction transition;
- trust issues added or removed.

The summary records maximum/final capacity change, changed trust-state years, engineering-review
eligibility changes, calibration IDs, and old/new dataset revision lists. Scenario code changes are
also visible even when the generated exposure remains numerically identical.

This report explains a result revision; it is not a warranty amendment or engineering approval.

## Execution

```powershell
calb-compare-standard-studies results\study-V1 results\study-V2 comparison.yaml comparison-V1.json
```

The output path is non-overwriting.

## Worker adapter

The comparison now has an independent job contract (`comparison-job` contract `1.0`). It is not
encoded as a scenario run: the payload carries a job identity, authenticated owner, comparison
engine/code revision, and one complete `StudyComparisonRequest` containing both verified study
evidence sets and the explicit tolerance policy.

The Python worker executes the existing like-for-like validator and writes an immutable bundle:

```text
<artifact-root>/<job-id>/study-comparison/
  comparison-request.json
  comparison-result.json
  comparison-manifest.json
```

The manifest binds both result versions and checksums the request and result. A lease retry may
reuse the directory only after the exact request, every file checksum, the recomputed comparison,
and the manifest identities all agree. The worker result exposes only summary deltas and artifact
checksums; the complete annual comparison remains in the evidence file.

The hosted control plane now exposes an independent D1 lease queue and R2 namespace under
`/api/worker/comparisons/**`. Start a dedicated process with
`--remote-base-url <site-url> --remote-job-kind study-comparison`; it claims only comparison jobs,
uploads the exact three-file bundle, and commits summary deltas only after R2 metadata and SHA-256
checks pass. The control plane also recomputes the like-for-like exposure axes, annual deltas,
direction counts, trust-state transitions, issue changes and provenance identities before the D1
completion batch is allowed. Browser submission is limited to two owned, completed standard-study
evidence sets.
