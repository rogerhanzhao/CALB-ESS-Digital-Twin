# Semi-empirical SOH calibration baseline

Status: engineering baseline for cross-review

Human-facing version: V0.2

Concept and system direction: Alex.Z

## Purpose

The baseline fits reviewed check-up observations to:

```text
capacity_loss_fraction = a × sqrt(elapsed_days) + b × absolute_throughput_ah ^ c
```

It separates calendar exposure from cycle throughput sufficiently to establish the first
reproducible reduced-order pipeline. It does not claim that these three coefficients alone are the
final CALB product model. Temperature, DoD, mean SOC, C-rate, product revision, and exposure bounds
are retained as a structured validity envelope for later binned or hierarchical models.

## Evidence rules

- Every observation references an immutable dataset revision, physical sample, and product
  revision.
- The request assigns `train` or `validation` explicitly. The same physical sample cannot occur in
  both splits.
- The calibration method explicitly declares its minimum independent training and validation
  sample counts. Four or more training observations are required so the three-parameter fit is
  overdetermined; repeated check-ups from one sample do not count as independent samples.
- The validity envelope is derived from training observations only. Validation points cannot
  silently expand it.
- Training exposure maxima and method-approved extrapolation limits are separate fields. The
  method may authorize a longer study horizon, but the artifact always retains how far beyond the
  observed evidence that authorization extends. Approved limits cannot be lower than the training
  evidence and generic code never invents them.
- Exponent bounds and the acceptable validation RMSE come from the versioned calibration method;
  generic code contains no product acceptance threshold.
- Coefficients are constrained non-negative, which makes predicted capacity non-increasing with
  calendar and throughput exposure.

## Fit decision

The artifact separately records solver convergence, Jacobian rank, constraint-boundary contact,
and held-out RMSE. `approval_eligible` is true only when all computational gates pass. It is not an
approval state and cannot replace engineering review. Rank-deficient or boundary-constrained fits
remain visible as draft evidence with warnings.

No confidence interval is emitted in V0.2. An interval must not be added until its source—sample
variance, parameter covariance, bootstrap, Monte Carlo, or a documented combination—is implemented
and recorded.

## Execution

After installing the package:

```powershell
calb-fit-soh-baseline calibration-request.yaml calibration-result.json
```

The command refuses to overwrite an existing result. It exits with code `2` when the fit is not
eligible for approval but still writes the diagnostic artifact for review.
