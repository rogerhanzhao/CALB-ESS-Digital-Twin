# Architecture

The platform separates proprietary data, model calibration, operational simulation, and
commercial warranty logic so that each layer can be validated independently.

This document was revised after the V0.1 design review. See `docs/design-review.md` for the
findings that motivated the changes and `docs/data-model.md` for the persistence contract.

## 1. Plane separation

Numerical work never runs in the web runtime. The platform has two physically separate planes
joined by a queue.

```text
                         ┌───────────────────────────────────┐
   Browser ────────────► │ Control plane (Workers + D1)      │
                         │ auth, validation, job records,    │
                         │ progress, result serving          │
                         └───────────┬───────────────────────┘
                                     │ queue (at-least-once, idempotent job id)
                                     ▼
                         ┌───────────────────────────────────┐
                         │ Compute plane (containerised      │
                         │ Python workers) lease, heartbeat, │
                         │ checkpoint                        │
                         └───────────┬───────────────────────┘
                                     ▼
              result time series + audit bundles → object storage
              structured summaries               → D1
```

The control plane runs on Cloudflare Workers and D1. That runtime cannot host PyBaMM — the
CPython scientific stack is CPU-bound, long-running, and needs local scratch — so the control
plane is restricted to authentication, input validation, durable job records, progress
reporting, and result serving. It performs no numerical work of any kind.

The compute plane is containerised Python. Workers claim queued jobs under a lease, emit
heartbeats, checkpoint intermediate state, and upload result artifacts. A worker restart
resumes from its latest checkpoint or safely retries an idempotent job. Capacity tiers, quotas,
and recovery rules are specified in `docs/deployment-and-capacity.md`.

## 2. Computation layers

1. `cell_database` validates cell metadata and exposes approved parameter sets.
2. `pybamm_models` maps approved parameters into PyBaMM experiments.
3. `soh_engine` calibrates against measured ageing data and extrapolates over the study horizon.
4. `dispatch` converts an ESS operating strategy into cell-level stress histories.
5. `system` translates cell-level state into system-level available energy and efficiency.
6. `warranty` evaluates energy-throughput, availability, SOH, and augmentation obligations.

Layers 3 and 5 are the two additions introduced by the design review. Both are described below
because they carry the decisions that determine whether the platform is tractable and whether
its output is usable.

## 3. Two-tier model strategy

A full PyBaMM cycle-by-cycle simulation over a 20-year horizon at one to three cycles per day is
not computationally tractable. The platform therefore runs two tiers, and `soh_engine` is split
accordingly.

**Tier 1 — high-fidelity calibration (`soh_engine.calibration`).** PyBaMM (SPMe plus degradation
submodels) is run over a bounded set of representative conditions and fitted against measured
CALB ageing data. The output is a parameter set for the reduced-order model, not a 20-year
trajectory.

**Tier 2 — reduced-order extrapolation (`soh_engine.extrapolation`).** A semi-empirical model
binned by temperature, depth of discharge, and mean state of charge — of the general form
`Q_loss = a·t^0.5 + b·Ah^c` — carries the calibrated behaviour across the full horizon. This is
what the study-length runs actually execute.

Every calibration records its fit quality (RMSE against held-out data) and an explicit
**validity envelope**: the temperature range, depth-of-discharge range, and extrapolation
horizon over which the fit is considered trustworthy. A run whose duty cycle leaves that
envelope is flagged in its results and must not be used to support a warranty conclusion.

## 4. Cell-to-system translation

Cell-level state of health is not a system-level guarantee. The `system` layer sits between
`dispatch` and `warranty` and makes the translation explicit rather than implicit:

- pack integration losses (cell → module → rack → system);
- the state-of-charge operating window, which separates rated from usable energy;
- auxiliary and thermal-management consumption;
- cell-to-cell dispersion, whose effect on usable system capacity frequently exceeds that of
  mean cell degradation;
- round-trip efficiency degradation.

`warranty` consumes system-level quantities only. It never reads cell-level SOH directly.

## 5. Uncertainty

`confidence_level` is a first-class model output, not a configuration constant. Every result
that carries a confidence interval must also declare where the uncertainty came from —
parameter uncertainty, measured sample variance, Monte Carlo sampling, extrapolation error, or a
combination. Warranty output is a commercial commitment, so an interval without a declared
source is not acceptable.

## 6. Contracts

The job payload and result schemas are defined once, in Python, using pydantic. That definition
is the single source of truth. JSON Schema is exported from it, and TypeScript types for the
control plane are generated from that export. Continuous integration verifies that both sides
agree. Neither plane hand-writes the other's types.

## 7. Auditability

All simulation results retain input-data versions, model versions, code revision, assumptions,
and run identifiers. Commercial warranty runs additionally retain an immutable audit bundle
containing inputs, model code revision, parameter-set revision, environment, logs, and output
checksums.

Results produced by the demonstrator progress engine — rather than by a real compute worker —
are permanently marked as such (`engine = 'demo'`) at the storage layer, are surfaced as such by
the API and the interface, and are never promoted to real results.
