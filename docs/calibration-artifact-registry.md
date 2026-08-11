# Calibration artifact registry

The V0.2 registry turns a fitted SOH model into auditable platform evidence. It does not
approve a calibration merely because a solver converged, and it does not allow the Web tier to
invent missing cell, scenario, or exposure values.

## Intended operating pattern

This platform is designed for a small number of controlled engineering studies, not a public
high-throughput simulation service. When CALB introduces a product revision, test evidence is
registered and validated, a calibration is fitted, and several released standard duty cycles
are executed. The immutable results are then reused for engineering, solution design, and
warranty analysis. New evidence creates a new calibration and a new result version; it never
rewrites the prior evidence chain.

## Registration and approval

`POST /api/calibrations` accepts the full generated `CalibrationResult` V0.2 artifact. The
control plane verifies that the selected product revision and every dataset revision belong to
the authenticated owner, validates the artifact against the Python-generated JSON Schema, and
writes canonical JSON bytes to the private `STUDY_ARTIFACTS` R2 bucket. D1 stores identity,
checksum, byte length, fit score, validity bounds, and normalized links to dataset revisions.

A newly registered artifact is `under_review`. `POST /api/calibrations/{id}/approve` advances
it to `approved` only when:

- the compute artifact itself says `approval_eligible = true`;
- at least one linked dataset revision exists and every linked revision has `pass` status;
- the private object still has the registered byte length, SHA-256 metadata, and calibration
  row identity; and
- the calibration is still `under_review` when the conditional update executes.

The compute engine's `approval_eligible` flag is therefore necessary but not sufficient. It is
a reproducible calculation outcome, while approval is a separate controlled workflow decision.

## Observation preparation

`soh_engine.calibration_observations` is the boundary between accepted cycle evidence and the
semi-empirical fitter. It creates `AgingObservation` records only for explicitly selected full
cycles. The engineer must provide the dataset revision, product revision, sample identity,
train/validation split, reference and nominal capacities, DoD, mean SOC, and any exposure that
occurred before the imported file began. These values come from the approved test plan and sample
history; they are not inferred from a convenient filename or assumed to be zero.

For each selected cycle, the builder derives measured capacity fraction from discharge capacity
and the explicit reference capacity, accumulates elapsed days, absolute throughput, equivalent full
cycles and completed-cycle count, and calculates temperature and charge/discharge C-rate from the
canonical measurements. Partial cycles and unavailable cycle selections are rejected. This layer
does not yet enqueue a hosted fit: it establishes the physically reviewable input contract that a
future calibration queue must consume.

The compute plane now defines that next boundary as the independent `calibration-fit` job contract.
Its payload embeds one frozen `CalibrationRequest`; the job UUID must equal `calibration_id`, and
the code revisions must agree. A worker writes `calibration-request.json`,
`calibration-result.json`, and `calibration-manifest.json` beneath a non-overwriting bundle path.
Retries verify the stored request, identities, evidence revision IDs, approval-eligibility summary,
exact file set, byte counts, and SHA-256 values before returning the existing result. The hosted
claim/upload/complete adapter remains the next control-plane slice; the current CLI intentionally
does not advertise a remote calibration queue before those endpoints exist.

## Envelope semantics

The reduced-order calibration records `mean_soc_min` and `mean_soc_max`. These describe the
mean SOC values represented by the fitting evidence. They are not the lower and upper bounds
of a duty-cycle SOC window. The registry stores them in dedicated columns and deliberately
leaves the older `soc_min` / `soc_max` window columns null; conflating these quantities would
allow an invalid warranty conclusion to appear in-range.

## Standard scenarios

New standard-scenario versions include the worker code revision, cell temperature, operating
availability, and maximum charge/discharge C-rates. Older V0.1 rows remain visible for history
but cannot be released or executed because those values were never captured. Release is an
explicit, idempotent transition from `draft` to `released`; changing any definition requires a
new version.

## Storage and hardware profile

Calibration registration and approval are lightweight control-plane operations: D1 queries,
JSON validation, hashing, and an R2 object write or metadata check. CPU-heavy fitting and
PyBaMM study execution stay in the leased Python worker. This separation keeps the Web service
small while allowing the worker host to be sized independently for the selected electrochemical
model and study batch. See `docs/deployment-and-capacity.md` for capacity guidance.

Concept & System Design · Alex.Z
