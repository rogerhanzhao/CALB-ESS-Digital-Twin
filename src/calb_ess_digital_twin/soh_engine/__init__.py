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
    "CalibrationRequest",
    "CalibrationResult",
    "CalibrationValidityEnvelope",
    "ExposurePoint",
    "ExtrapolationLimits",
    "ExtrapolationRequest",
    "ExtrapolationResult",
    "SemiEmpiricalParameters",
    "SplitRole",
    "StandardScenarioConditions",
    "TrajectoryIssue",
    "capacity_fraction",
    "extrapolate_soh",
    "fit_semi_empirical_model",
]
