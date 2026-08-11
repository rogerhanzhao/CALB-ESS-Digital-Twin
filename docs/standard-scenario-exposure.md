# Standard scenario exposure generation

Status: engineering baseline for cross-review

Human-facing version: V0.2

Concept and system direction: Alex.Z

## Purpose

This component turns one approved standard-scenario version into deterministic annual exposure
points consumed by SOH extrapolation. It is intended for the small set of repeatable job-specific
studies used when a new product, test-data revision, or solution becomes available.

Inputs include the product revision, study start date, horizon, nominal cell capacity, SOC window,
cycles per operating day, operating availability, cell temperature, and charge/discharge C-rate.
The SOC window and DoD must agree exactly within a named numerical tolerance. The plan also records
the code revision that generated the artifact.

## Calculation basis

For each calendar anniversary:

```text
operating_days = actual_calendar_days × availability
scheduled_cycles = operating_days × cycles_per_operating_day
EFC = scheduled_cycles × DoD
absolute_throughput_Ah = 2 × nominal_capacity_Ah × EFC
```

Actual calendar days retain leap years. Scheduled cycles remain fractional and are never rounded.
The factor of two represents absolute charge plus discharge throughput.

## Boundary

The artifact is a nominal constant-duty exposure plan, not an economic dispatch or delivered-energy
simulation. It does not include capacity fade feedback, auxiliary consumption, thermal management,
RTE, PCS limits, downtime chronology, or grid-price optimization. Those effects belong in the
future dispatch and cell-to-system translation layers and must not be inferred from this artifact.

Optional initial exposure supports an already-aged commissioning state. Historical throughput,
cycles, and EFC remain explicit independent fields; generic code does not reconstruct or overwrite
them.

## Execution

```powershell
calb-build-standard-exposure scenario-plan.yaml scenario-exposure.json
```

The artifact path is non-overwriting. The resulting conditions and annual points can be inserted
directly into a versioned SOH extrapolation request.
