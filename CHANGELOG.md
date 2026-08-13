# Version history

All public version labels in this project use an uppercase `V`.

Internal schema and contract versions (`V0.2` schema, `2.0` contract) are data-format
identifiers and evolve independently of the release version.

## Unreleased

Compute plane

- Added the contract layer (`contracts/`): pydantic job/result schemas as the single source of
  truth, JSON Schema export, and generated TypeScript types for the control plane.
- Added the compute worker skeleton (`compute/`): a SQLite-backed local queue with leases,
  heartbeats, and checkpoints, plus a containerised worker Dockerfile.
- Added measured test-data intake validation and derived cycle-ageing metrics (`cell_database/`).
- Added the auditable semi-empirical SOH baseline calibration (`soh_engine.calibration`) with
  train/validation leakage protection, identifiability checks, and validity-envelope evidence.
- Added the bounded PyBaMM SPMe reference runner (`pybamm_models/`).
- Declared the SciPy dependency the calibration fit relies on.

## Unreleased — V0.1 design review

Design review of the V0.1 foundation and the P0 remediation it called for. Findings,
priorities, and the staged plan are recorded in `docs/design-review.md`.

Documentation

- Added `docs/design-review.md`: the review record and the M0–M3 implementation plan.
- Added `docs/data-model.md`: the control-plane persistence contract and write-ownership rules.
- Added `docs/collaboration-claude-codex.md`: dual-agent workflow, ownership split, and the
  three-layer cross-validation mechanism.
- Revised `docs/architecture.md`: separated the control and compute planes, made the two-tier
  model strategy (high-fidelity calibration plus reduced-order extrapolation) explicit, added
  the cell-to-system translation layer ahead of warranty, and made uncertainty provenance a
  first-class requirement.

Control plane

- Made the run list endpoint strictly read-only. Demonstrator progress is derived per request
  and no longer written back to the database, removing a write race with the future compute
  worker.
- Added a permanent `engine` provenance marker. Demonstrator output can no longer be mistaken
  for model results once a compute worker is connected.
- Split `simulations` into `scenarios`, `runs`, and `run_artifacts`, capturing the input,
  model, and code versions the architecture already required, plus the lease, heartbeat, and
  checkpoint fields the deployment guide already required.
- Replaced silent input clamping with explicit validation and `400` responses; switched run
  identifiers to UUIDs; added idempotency keys, single-run retrieval, cancellation, paging,
  and a chemistry whitelist.
- Surfaced demonstrator mode in the interface and replaced fabricated dashboard metrics with
  explicit placeholders.
- Added unit tests covering the validation and demonstrator-derivation rules, and removed a
  scaffold test that referenced a file this repository never contained.

Cross-review revisions (CODEX, round one)

- Only an omitted field now falls back to a default. An explicit `null`, an empty string, or a
  wrong type is rejected, since defaulting them would silently run a different simulation than
  the caller described.
- A malformed `Idempotency-Key` header is rejected rather than ignored. Discarding it quietly
  dropped the retry guarantee at the one moment it was supposed to hold, producing a duplicate
  run.
- Cancellation now judges terminality on the derived view rather than the stored row, so a
  demonstrator run the interface has already shown as completed can no longer be cancelled.

Engineering gates

- Added continuous integration: ruff and pytest for the compute plane; lint, typecheck, build,
  and tests for the control plane; and a check that the schema and its migrations stay in step.
  The project had no working gate before this.
- Declared the worker's runtime bindings so `tsc` runs clean and can gate, resolving three type
  errors that predate the review.
- Added a pull request template that carries the cross-review checklist.

## V0.1 — Initial platform foundation

- Established the PyBaMM, CALB cell database, SOH engine, ESS dispatch, and warranty-analysis architecture.
- Added the Web simulation workspace and user-specific persistent task records.
- Added deployment capacity, compute-worker, checkpoint, and recovery guidance.
- Aligned the interface with the CALB ESS visual identity while keeping product branding understated.

Concept, system design, validation, and iteration direction: **Alex.Z**.
