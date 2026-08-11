"""Versioned reduced-order SOH trajectory with explicit validity-envelope checks."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .calibration import CalibrationResult, CalibrationValidityEnvelope, capacity_fraction


class CalibrationApprovalStatus(StrEnum):
    DRAFT = "draft"
    UNDER_REVIEW = "under_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class TrajectoryIssue(StrEnum):
    TEMPERATURE = "temperature_outside_calibration"
    DEPTH_OF_DISCHARGE = "depth_of_discharge_outside_calibration"
    MEAN_SOC = "mean_soc_outside_calibration"
    CHARGE_C_RATE = "charge_c_rate_outside_calibration"
    DISCHARGE_C_RATE = "discharge_c_rate_outside_calibration"
    ELAPSED_DAYS = "elapsed_days_exceed_calibration"
    CYCLE_COUNT = "cycle_count_exceeds_calibration"
    EQUIVALENT_FULL_CYCLES = "equivalent_full_cycles_exceed_calibration"
    ABSOLUTE_THROUGHPUT = "absolute_throughput_exceeds_calibration"
    NON_PHYSICAL_CAPACITY = "predicted_capacity_outside_zero_to_one"


class StandardScenarioConditions(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    product_revision: str = Field(min_length=1)
    cell_temperature_c: float
    depth_of_discharge: float = Field(ge=0, le=1)
    mean_soc: float = Field(ge=0, le=1)
    max_charge_c_rate: float = Field(ge=0)
    max_discharge_c_rate: float = Field(ge=0)


class ExposurePoint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    year: int = Field(ge=0)
    elapsed_days: float = Field(ge=0)
    absolute_throughput_ah: float = Field(ge=0)
    cycle_count: float = Field(ge=0)
    equivalent_full_cycles: float = Field(ge=0)


class ExtrapolationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    result_version: str = Field(min_length=1)
    standard_scenario_version: str = Field(min_length=1)
    calibration: CalibrationResult
    calibration_approval_status: CalibrationApprovalStatus
    conditions: StandardScenarioConditions
    exposure_points: list[ExposurePoint] = Field(min_length=1)

    @model_validator(mode="after")
    def trajectory_and_approval_are_consistent(self) -> ExtrapolationRequest:
        if self.conditions.product_revision != self.calibration.product_revision:
            raise ValueError("scenario product_revision does not match calibration")
        if (
            self.calibration.validity_envelope.product_revision
            != self.calibration.product_revision
        ):
            raise ValueError(
                "calibration validity-envelope product_revision does not match calibration"
            )
        if (
            self.calibration_approval_status == CalibrationApprovalStatus.APPROVED
            and not self.calibration.approval_eligible
        ):
            raise ValueError("computationally ineligible calibration cannot be marked approved")
        if self.exposure_points[0].year != 0:
            raise ValueError("exposure trajectory must start at year 0")
        for previous, current in zip(self.exposure_points, self.exposure_points[1:]):
            if current.year <= previous.year:
                raise ValueError("exposure point years must strictly increase")
            for field in (
                "elapsed_days",
                "absolute_throughput_ah",
                "cycle_count",
                "equivalent_full_cycles",
            ):
                if getattr(current, field) < getattr(previous, field):
                    raise ValueError(f"{field} must not decrease across the trajectory")
        return self


class ExtrapolationPoint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    year: int
    elapsed_days: float
    absolute_throughput_ah: float
    cycle_count: float
    equivalent_full_cycles: float
    predicted_capacity_fraction: float
    within_validity_envelope: bool
    physically_valid_prediction: bool
    issues: tuple[TrajectoryIssue, ...]


class ExtrapolationResult(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    result_version: str
    standard_scenario_version: str
    calibration_id: str
    calibration_model_version: str
    calibration_approval_status: CalibrationApprovalStatus
    product_revision: str
    points: list[ExtrapolationPoint]
    all_points_within_validity_envelope: bool
    all_predictions_physically_valid: bool
    engineering_review_eligible: bool
    uncertainty_status: Literal["not_quantified"] = "not_quantified"
    warranty_eligible: Literal[False] = False
    warnings: list[str]


def extrapolate_soh(request: ExtrapolationRequest) -> ExtrapolationResult:
    """Evaluate every requested exposure point without clipping or hiding violations."""

    envelope = request.calibration.validity_envelope
    exposure_limits = envelope.approved_extrapolation_limits
    condition_violations = _condition_violations(request.conditions, envelope)
    points: list[ExtrapolationPoint] = []
    for exposure in request.exposure_points:
        predicted = float(
            capacity_fraction(
                exposure.elapsed_days,
                exposure.absolute_throughput_ah,
                request.calibration.parameters,
            )
        )
        violations = list(condition_violations)
        if exposure.elapsed_days > exposure_limits.maximum_elapsed_days:
            violations.append(TrajectoryIssue.ELAPSED_DAYS)
        if exposure.cycle_count > exposure_limits.maximum_cycle_count:
            violations.append(TrajectoryIssue.CYCLE_COUNT)
        if exposure.equivalent_full_cycles > exposure_limits.maximum_equivalent_full_cycles:
            violations.append(TrajectoryIssue.EQUIVALENT_FULL_CYCLES)
        if exposure.absolute_throughput_ah > exposure_limits.maximum_absolute_throughput_ah:
            violations.append(TrajectoryIssue.ABSOLUTE_THROUGHPUT)
        physically_valid = 0 <= predicted <= 1
        envelope_violations = tuple(violations)
        if not physically_valid:
            violations.append(TrajectoryIssue.NON_PHYSICAL_CAPACITY)
        unique_violations = tuple(dict.fromkeys(violations))
        points.append(
            ExtrapolationPoint(
                **exposure.model_dump(),
                predicted_capacity_fraction=predicted,
                within_validity_envelope=not envelope_violations,
                physically_valid_prediction=physically_valid,
                issues=unique_violations,
            )
        )

    all_within = all(point.within_validity_envelope for point in points)
    all_physical = all(point.physically_valid_prediction for point in points)
    approved = request.calibration_approval_status == CalibrationApprovalStatus.APPROVED
    warnings = [
        "uncertainty is not quantified; this trajectory cannot directly support warranty output"
    ]
    if not approved:
        warnings.append("calibration is not approved; trajectory is exploratory")
    if not all_within:
        warnings.append("one or more trajectory points leave the calibration validity envelope")
    if not all_physical:
        warnings.append("one or more model predictions are outside the physical capacity range")
    return ExtrapolationResult(
        result_version=request.result_version,
        standard_scenario_version=request.standard_scenario_version,
        calibration_id=request.calibration.calibration_id,
        calibration_model_version=request.calibration.model_version,
        calibration_approval_status=request.calibration_approval_status,
        product_revision=request.conditions.product_revision,
        points=points,
        all_points_within_validity_envelope=all_within,
        all_predictions_physically_valid=all_physical,
        engineering_review_eligible=approved and all_within and all_physical,
        warnings=warnings,
    )


def _condition_violations(
    conditions: StandardScenarioConditions, envelope: CalibrationValidityEnvelope
) -> list[TrajectoryIssue]:
    violations: list[TrajectoryIssue] = []
    checks = (
        (
            conditions.cell_temperature_c,
            envelope.temperature_min_c,
            envelope.temperature_max_c,
            TrajectoryIssue.TEMPERATURE,
        ),
        (
            conditions.depth_of_discharge,
            envelope.depth_of_discharge_min,
            envelope.depth_of_discharge_max,
            TrajectoryIssue.DEPTH_OF_DISCHARGE,
        ),
        (
            conditions.mean_soc,
            envelope.mean_soc_min,
            envelope.mean_soc_max,
            TrajectoryIssue.MEAN_SOC,
        ),
        (
            conditions.max_charge_c_rate,
            envelope.charge_c_rate_min,
            envelope.charge_c_rate_max,
            TrajectoryIssue.CHARGE_C_RATE,
        ),
        (
            conditions.max_discharge_c_rate,
            envelope.discharge_c_rate_min,
            envelope.discharge_c_rate_max,
            TrajectoryIssue.DISCHARGE_C_RATE,
        ),
    )
    for value, lower, upper, violation in checks:
        if not lower <= value <= upper:
            violations.append(violation)
    return violations
