# Version history

All public version labels in this project use an uppercase `V`.

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

## V0.1 — Initial platform foundation

- Established the PyBaMM, CALB cell database, SOH engine, ESS dispatch, and warranty-analysis architecture.
- Added the Web simulation workspace and user-specific persistent task records.
- Added deployment capacity, compute-worker, checkpoint, and recovery guidance.
- Aligned the interface with the CALB ESS visual identity while keeping product branding understated.

Concept, system design, validation, and iteration direction: **Alex.Z**.
