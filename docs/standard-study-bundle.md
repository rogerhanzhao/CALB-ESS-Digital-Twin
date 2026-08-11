# Standard study bundle

Status: engineering baseline for cross-review

Human-facing version: V0.2

Concept and system direction: Alex.Z

## Purpose

One standard study joins a frozen standard-scenario plan with one calibration version, generates
annual nominal exposure, evaluates the SOH trajectory, and writes a new immutable local result
directory. Re-running after new test data or a new calibration creates a new `study_version` and
`result_version`; it does not replace the prior evidence.

## Bundle contents

```text
study-request.json       exact normalized request, including calibration and scenario plan
scenario-exposure.json   annual calendar/exposure artifact
soh-result.json          annual SOH and point-level trust status
manifest.json            versions, code revisions, byte counts, and SHA-256 checksums
```

The three evidence files are serialized deterministically and checksummed over the exact bytes
written. The output directory is assembled in a temporary sibling and renamed only after every file
is complete. An existing target directory is never overwritten.

The manifest deliberately records scenario and calibration code revisions separately. Updating the
scenario generator without changing the calibration, or recalibrating without changing the standard
scenario, remains visible in the evidence chain. It also lists every calibration dataset revision,
the calibration approval status, and the resulting engineering-review and warranty states so a
later result update can be traced directly to newly introduced physical evidence.

## Boundary

This bundle proves which inputs and reduced-order calculations produced a result. It does not by
itself provide container image digest, dependency-lock checksum, object-storage immutability,
electronic approval, uncertainty, system translation, or warranty eligibility. Those fields must be
added by the execution/control planes before an approved commercial result can exist.

## Execution

```powershell
calb-run-standard-study standard-study.yaml results\study-V1
```

The command returns code `2` when diagnostic artifacts are created but the SOH result is not eligible
for engineering review.
