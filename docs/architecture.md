# Architecture

The platform separates proprietary data, model calibration, operational simulation, and commercial warranty logic so that each layer can be validated independently.

1. `cell_database` validates cell metadata and exposes approved parameter sets.
2. `pybamm_models` maps approved parameters into PyBaMM experiments.
3. `soh_engine` combines calendar and cycle ageing and tracks capacity and resistance.
4. `dispatch` converts an ESS operating strategy into cell-level stress histories.
5. `warranty` evaluates energy-throughput, availability, SOH, and augmentation obligations.

All simulation results should retain input-data versions, model versions, assumptions, and run identifiers for auditability.
