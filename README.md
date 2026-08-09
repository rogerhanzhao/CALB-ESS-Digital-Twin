# CALB ESS Digital Twin

An engineering platform for CALB lithium-iron-phosphate (LFP) cell ageing, ESS state-of-health (SOH) simulation, dispatch analysis, and warranty risk assessment.

**Current release: V0.1**

## Scope

- **PyBaMM models** — electrochemical and degradation model adapters.
- **CALB cell database** — versioned cell parameters, test metadata, and ageing datasets.
- **SOH engine** — calendar/cycle ageing, resistance growth, and model calibration.
- **ESS dispatch simulator** — operating profiles, thermal conditions, and dispatch strategies.
- **Warranty analysis** — guaranteed-energy checks, augmentation scenarios, and risk reporting.

## Architecture

```text
Cell data + test results
          |
          v
PyBaMM adapters --> SOH engine --> ESS dispatch simulator --> Warranty analysis
                         |                  |
                         +---- results -----+
```

## Repository layout

```text
configs/                 Example model and scenario configuration
data/                    Local data zones (raw data is never committed)
docs/                    Architecture and model documentation
notebooks/               Exploration and model-validation notebooks
src/calb_ess_digital_twin/
  cell_database/         Cell definitions and dataset access
  pybamm_models/         PyBaMM model construction and parameter mapping
  soh_engine/            Degradation and SOH calculations
  dispatch/              ESS duty-cycle and dispatch simulation
  warranty/              Warranty KPIs and risk analysis
tests/                   Automated tests
```

## Quick start

Requires Python 3.11 or newer.

```bash
python -m venv .venv
pip install -e ".[dev]"
pytest
```

## Data governance

Proprietary CALB cell and field data must not be committed to Git. Store local inputs under `data/raw/`; publish only reviewed, anonymized derived datasets when permitted.

## Status

Initial architecture scaffold. The next milestone is a single-cell LFP baseline model with a documented parameter set and a reproducible reference duty cycle.

The first Web control plane is under `web/`. It provides a user-specific persistent task queue and a simulation dashboard. Production compute sizing, background-job behavior, and recovery requirements are documented in `docs/deployment-and-capacity.md`.

The compute plane is not yet connected, so every run is currently served by the demonstrator progress engine, is stored with `engine = 'demo'`, and is labelled as such in the interface. Demonstrator output must not be used for commercial warranty decisions.

## Design documents

- `docs/architecture.md` — plane separation, the two-tier model strategy, cell-to-system translation, and auditability.
- `docs/data-model.md` — control-plane persistence contract and write ownership.
- `docs/deployment-and-capacity.md` — compute sizing, guardrails, availability, and recovery.
- `docs/design-review.md` — V0.1 design review findings and the staged M0–M3 plan.
- `docs/collaboration-claude-codex.md` — dual-agent development workflow and cross-review process.

## License

Proprietary — internal use unless a separate license is approved.

## Project attribution

Concept, system design, validation, and iteration direction are led by **Alex.Z**.

© 2026 Alex.Z. All rights reserved.
