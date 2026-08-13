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

__all__ = [
    "AgingObservation",
    "CalibrationRequest",
    "CalibrationResult",
    "CalibrationValidityEnvelope",
    "ExtrapolationLimits",
    "SemiEmpiricalParameters",
    "SplitRole",
    "capacity_fraction",
    "fit_semi_empirical_model",
]
