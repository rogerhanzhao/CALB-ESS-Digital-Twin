"""SOH estimation, degradation, and calibration engine."""

from .calibration import (
    AgingObservation,
    CalibrationRequest,
    CalibrationResult,
    CalibrationValidityEnvelope,
    ExtrapolationLimits,
    SemiEmpiricalParameters,
    SplitRole,
    capacity_fraction,
    fit_semi_empirical_model,
)
from .calibration_bundle import (
    CalibrationBundleManifest,
    verify_calibration_bundle,
    write_calibration_bundle,
)
from .calibration_observations import (
    RevisionObservationSelection,
    build_revision_observations,
)
from .extrapolation import (
    CalibrationApprovalStatus,
    ExposurePoint,
    ExtrapolationRequest,
    ExtrapolationResult,
    StandardScenarioConditions,
    TrajectoryIssue,
    extrapolate_soh,
)

__all__ = [
    "AgingObservation",
    "CalibrationApprovalStatus",
    "CalibrationBundleManifest",
    "CalibrationRequest",
    "CalibrationResult",
    "CalibrationValidityEnvelope",
    "ExposurePoint",
    "ExtrapolationLimits",
    "ExtrapolationRequest",
    "ExtrapolationResult",
    "RevisionObservationSelection",
    "SemiEmpiricalParameters",
    "SplitRole",
    "StandardScenarioConditions",
    "TrajectoryIssue",
    "build_revision_observations",
    "capacity_fraction",
    "extrapolate_soh",
    "fit_semi_empirical_model",
    "verify_calibration_bundle",
    "write_calibration_bundle",
]
