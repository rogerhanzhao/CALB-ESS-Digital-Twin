# Reduced-order SOH extrapolation

Status: engineering baseline for cross-review

Human-facing version: V0.2

Concept and system direction: Alex.Z

## Purpose

The extrapolator consumes one immutable calibration artifact and a versioned standard-scenario
exposure trajectory. Each requested annual point records elapsed days, absolute Ah throughput,
cycles, equivalent full cycles, and the raw predicted capacity fraction.

The engine does not generate duty-cycle exposure itself. Dispatch and ESS translation remain the
authoritative sources of the exposure trajectory, so calibration, dispatch, and SOH evaluation do
not silently duplicate assumptions.

## Trust boundaries

- Scenario product revision must exactly match the calibration.
- A calibration marked `approved` must first have passed its computational gates. Draft and
  under-review calibrations remain available for exploratory runs.
- Temperature, DoD, mean SOC, charge/discharge C-rate, elapsed time, cycles, EFC, and throughput
  are checked at every point. Operating-condition ranges come from training evidence; exposure
  horizons use the method-approved extrapolation limits while retaining the lower observed training
  maxima in the calibration artifact.
- Input-envelope status and output physical validity are separate. A negative predicted capacity
  is retained as raw diagnostic evidence, never clipped to zero, and blocks engineering review.
- Exposure dimensions and years must be monotone. Historical exposure cannot decrease between
  result points.

## Warranty boundary

V0.2 reports `uncertainty_status = not_quantified` and therefore always reports
`warranty_eligible = false`. Even an approved, fully in-envelope trajectory is only eligible for
engineering review. Warranty eligibility requires a documented uncertainty source plus the future
cell-to-system translation and warranty layers.

## Execution

```powershell
calb-extrapolate-soh extrapolation-request.yaml soh-result.json
```

The result path is non-overwriting. Exit code `2` means the artifact was produced for diagnostics
but is not eligible for engineering review.
