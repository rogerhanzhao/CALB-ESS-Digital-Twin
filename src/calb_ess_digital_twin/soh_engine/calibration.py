"""Auditable baseline calibration for the reduced-order LFP ageing model.

This module fits measured capacity loss to ``a*sqrt(days) + b*Ah**c``.  It is
an engineering baseline, not an approved CALB product model: approval remains a
separate state transition and requires real, reviewed dataset revisions.
"""

from __future__ import annotations

import math
from enum import StrEnum
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator
from scipy.optimize import least_squares

SCHEMA_VERSION = "V0.2"


class SplitRole(StrEnum):
    TRAIN = "train"
    VALIDATION = "validation"


class AgingObservation(BaseModel):
    """One reviewed check-up point from a versioned physical dataset revision."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    observation_id: str = Field(min_length=1)
    dataset_revision_id: str = Field(min_length=1)
    product_revision: str = Field(min_length=1)
    sample_id: str = Field(min_length=1)
    split: SplitRole
    elapsed_days: float = Field(ge=0)
    absolute_throughput_ah: float = Field(ge=0)
    measured_capacity_fraction: float = Field(gt=0)
    cell_temperature_c: float
    depth_of_discharge: float = Field(ge=0, le=1)
    mean_soc: float = Field(ge=0, le=1)
    max_charge_c_rate: float = Field(ge=0)
    max_discharge_c_rate: float = Field(ge=0)
    cycle_count: int = Field(ge=0)
    equivalent_full_cycles: float = Field(ge=0)


class CalibrationRequest(BaseModel):
    """Frozen method configuration plus explicitly assigned train/validation data."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = SCHEMA_VERSION
    calibration_id: str = Field(min_length=1)
    model_version: str = Field(min_length=1)
    code_revision: str = Field(min_length=7)
    observations: list[AgingObservation] = Field(min_length=5)
    exponent_min: float = Field(gt=0)
    exponent_max: float = Field(gt=0)
    validation_rmse_limit_fraction: float = Field(ge=0)
    minimum_training_sample_count: int = Field(ge=1)
    minimum_validation_sample_count: int = Field(ge=1)
    approved_extrapolation_limits: ExtrapolationLimits

    @model_validator(mode="after")
    def method_is_auditable_and_leak_free(self) -> CalibrationRequest:
        if self.exponent_max <= self.exponent_min:
            raise ValueError("exponent_max must be greater than exponent_min")
        observation_ids = [item.observation_id for item in self.observations]
        if len(observation_ids) != len(set(observation_ids)):
            raise ValueError("observation_id values must be unique")
        products = {item.product_revision for item in self.observations}
        if len(products) != 1:
            raise ValueError("one calibration may reference exactly one product_revision")
        train = [item for item in self.observations if item.split == SplitRole.TRAIN]
        validation = [item for item in self.observations if item.split == SplitRole.VALIDATION]
        if len(train) < 4:
            raise ValueError("at least four training observations are required for three parameters")
        if not validation:
            raise ValueError("at least one held-out validation observation is required")
        train_samples = {item.sample_id for item in train}
        validation_samples = {item.sample_id for item in validation}
        overlap = sorted(train_samples & validation_samples)
        if overlap:
            raise ValueError(f"sample leakage across train and validation splits: {overlap}")
        if len(train_samples) < self.minimum_training_sample_count:
            raise ValueError("training split does not meet minimum_training_sample_count")
        if len(validation_samples) < self.minimum_validation_sample_count:
            raise ValueError("validation split does not meet minimum_validation_sample_count")
        observed_maxima = {
            "maximum_elapsed_days": max(item.elapsed_days for item in train),
            "maximum_cycle_count": max(item.cycle_count for item in train),
            "maximum_equivalent_full_cycles": max(
                item.equivalent_full_cycles for item in train
            ),
            "maximum_absolute_throughput_ah": max(
                item.absolute_throughput_ah for item in train
            ),
        }
        for field, observed in observed_maxima.items():
            if getattr(self.approved_extrapolation_limits, field) < observed:
                raise ValueError(
                    f"approved_extrapolation_limits.{field} cannot be below training evidence"
                )
        return self


class SemiEmpiricalParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    calendar_coefficient_per_sqrt_day: float = Field(ge=0)
    throughput_coefficient_per_ah_power: float = Field(ge=0)
    throughput_exponent: float = Field(gt=0)


class FitMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    training_rmse_fraction: float = Field(ge=0)
    validation_rmse_fraction: float = Field(ge=0)
    validation_max_absolute_error_fraction: float = Field(ge=0)
    jacobian_rank: int = Field(ge=0)
    jacobian_condition_number: float | None = Field(default=None, ge=0)
    solver_cost: float = Field(ge=0)
    solver_evaluations: int = Field(ge=0)


class ExtrapolationLimits(BaseModel):
    """Method-approved horizon; separate from the observed training exposure."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    maximum_elapsed_days: float = Field(ge=0)
    maximum_cycle_count: int = Field(ge=0)
    maximum_equivalent_full_cycles: float = Field(ge=0)
    maximum_absolute_throughput_ah: float = Field(ge=0)


class CalibrationValidityEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    product_revision: str
    temperature_min_c: float
    temperature_max_c: float
    depth_of_discharge_min: float
    depth_of_discharge_max: float
    mean_soc_min: float
    mean_soc_max: float
    charge_c_rate_min: float
    charge_c_rate_max: float
    discharge_c_rate_min: float
    discharge_c_rate_max: float
    training_maximum_elapsed_days: float
    training_maximum_cycle_count: int
    training_maximum_equivalent_full_cycles: float
    training_maximum_absolute_throughput_ah: float
    approved_extrapolation_limits: ExtrapolationLimits


class ObservationFit(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    observation_id: str
    split: SplitRole
    measured_capacity_fraction: float
    predicted_capacity_fraction: float
    residual_fraction: float


class CalibrationResult(BaseModel):
    """Draft calibration artifact; ``approval_eligible`` is not approval."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = SCHEMA_VERSION
    calibration_id: str
    model_version: str
    code_revision: str
    product_revision: str
    dataset_revision_ids: tuple[str, ...]
    parameters: SemiEmpiricalParameters
    metrics: FitMetrics
    validity_envelope: CalibrationValidityEnvelope
    fit_converged: bool
    identifiable: bool
    parameters_at_bounds: bool
    meets_validation_limit: bool
    approval_eligible: bool
    warnings: list[str]
    observation_fits: list[ObservationFit]

    @model_validator(mode="after")
    def approval_eligibility_matches_gates(self) -> CalibrationResult:
        derived = bool(
            self.fit_converged
            and self.identifiable
            and not self.parameters_at_bounds
            and self.meets_validation_limit
        )
        if self.approval_eligible != derived:
            raise ValueError(
                "approval_eligible must equal fit_converged AND identifiable AND "
                "(not parameters_at_bounds) AND meets_validation_limit"
            )
        return self


def capacity_fraction(
    elapsed_days: np.ndarray | float,
    absolute_throughput_ah: np.ndarray | float,
    parameters: SemiEmpiricalParameters,
) -> np.ndarray:
    """Evaluate the monotone baseline model in its native fitted units."""

    days = np.asarray(elapsed_days, dtype=float)
    throughput = np.asarray(absolute_throughput_ah, dtype=float)
    if np.any(~np.isfinite(days)) or np.any(~np.isfinite(throughput)):
        raise ValueError("prediction inputs must be finite")
    if np.any(days < 0) or np.any(throughput < 0):
        raise ValueError("prediction exposure cannot be negative")
    loss = (
        parameters.calendar_coefficient_per_sqrt_day * np.sqrt(days)
        + parameters.throughput_coefficient_per_ah_power
        * np.power(throughput, parameters.throughput_exponent)
    )
    return 1.0 - loss


def fit_semi_empirical_model(request: CalibrationRequest) -> CalibrationResult:
    """Fit a constrained baseline and score only against held-out samples."""

    train = [item for item in request.observations if item.split == SplitRole.TRAIN]
    validation = [item for item in request.observations if item.split == SplitRole.VALIDATION]
    train_days, train_ah, train_loss = _arrays(train)
    validation_days, validation_ah, validation_loss = _arrays(validation)

    observed_loss_scale = max(float(np.median(np.maximum(train_loss, 0))), 1e-8)
    initial_a = observed_loss_scale / max(math.sqrt(float(train_days.max())), 1.0) / 2
    initial_c = (request.exponent_min + request.exponent_max) / 2
    initial_b = observed_loss_scale / max(float(train_ah.max()) ** initial_c, 1.0) / 2

    def residuals(values: np.ndarray) -> np.ndarray:
        a, b, c = values
        return a * np.sqrt(train_days) + b * np.power(train_ah, c) - train_loss

    solution = least_squares(
        residuals,
        x0=np.array([initial_a, initial_b, initial_c]),
        bounds=(
            np.array([0.0, 0.0, request.exponent_min]),
            np.array([np.inf, np.inf, request.exponent_max]),
        ),
        x_scale="jac",
    )
    parameters = SemiEmpiricalParameters(
        calendar_coefficient_per_sqrt_day=float(solution.x[0]),
        throughput_coefficient_per_ah_power=float(solution.x[1]),
        throughput_exponent=float(solution.x[2]),
    )

    train_prediction_loss = 1.0 - capacity_fraction(train_days, train_ah, parameters)
    validation_prediction_loss = 1.0 - capacity_fraction(
        validation_days, validation_ah, parameters
    )
    train_error = train_prediction_loss - train_loss
    validation_error = validation_prediction_loss - validation_loss
    jacobian_rank = int(np.linalg.matrix_rank(solution.jac))
    condition = _finite_condition_number(solution.jac, jacobian_rank)
    identifiable = jacobian_rank == 3
    parameters_at_bounds = bool(
        np.isclose(solution.x[0], 0.0, atol=1e-12)
        or np.isclose(solution.x[1], 0.0, atol=1e-12)
        or np.isclose(solution.x[2], request.exponent_min, rtol=1e-6, atol=1e-8)
        or np.isclose(solution.x[2], request.exponent_max, rtol=1e-6, atol=1e-8)
    )
    validation_rmse = _rmse(validation_error)
    meets_limit = validation_rmse <= request.validation_rmse_limit_fraction
    warnings: list[str] = []
    if not solution.success:
        warnings.append(f"solver did not converge: {solution.message}")
    if not identifiable:
        warnings.append("parameter Jacobian is rank-deficient; coefficients are not identifiable")
    if parameters_at_bounds:
        warnings.append("one or more fitted parameters are at a configured constraint boundary")
    if not meets_limit:
        warnings.append("held-out validation RMSE exceeds the configured method limit")

    observation_fits = [
        _observation_fit(item, parameters) for item in request.observations
    ]
    return CalibrationResult(
        calibration_id=request.calibration_id,
        model_version=request.model_version,
        code_revision=request.code_revision,
        product_revision=train[0].product_revision,
        dataset_revision_ids=tuple(
            sorted({item.dataset_revision_id for item in request.observations})
        ),
        parameters=parameters,
        metrics=FitMetrics(
            training_rmse_fraction=_rmse(train_error),
            validation_rmse_fraction=validation_rmse,
            validation_max_absolute_error_fraction=float(np.max(np.abs(validation_error))),
            jacobian_rank=jacobian_rank,
            jacobian_condition_number=condition,
            solver_cost=float(solution.cost),
            solver_evaluations=int(solution.nfev),
        ),
        validity_envelope=_envelope(train, request.approved_extrapolation_limits),
        fit_converged=bool(solution.success),
        identifiable=identifiable,
        parameters_at_bounds=parameters_at_bounds,
        meets_validation_limit=meets_limit,
        approval_eligible=bool(
            solution.success and identifiable and not parameters_at_bounds and meets_limit
        ),
        warnings=warnings,
        observation_fits=observation_fits,
    )


def _arrays(
    observations: list[AgingObservation],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    days = np.array([item.elapsed_days for item in observations], dtype=float)
    throughput = np.array([item.absolute_throughput_ah for item in observations], dtype=float)
    capacity_loss = np.array(
        [1.0 - item.measured_capacity_fraction for item in observations], dtype=float
    )
    return days, throughput, capacity_loss


def _rmse(error: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(error))))


def _finite_condition_number(jacobian: np.ndarray, rank: int) -> float | None:
    if rank < jacobian.shape[1]:
        return None
    condition = float(np.linalg.cond(jacobian))
    return condition if math.isfinite(condition) else None


def _observation_fit(
    observation: AgingObservation, parameters: SemiEmpiricalParameters
) -> ObservationFit:
    predicted = float(
        capacity_fraction(
            observation.elapsed_days, observation.absolute_throughput_ah, parameters
        )
    )
    return ObservationFit(
        observation_id=observation.observation_id,
        split=observation.split,
        measured_capacity_fraction=observation.measured_capacity_fraction,
        predicted_capacity_fraction=predicted,
        residual_fraction=predicted - observation.measured_capacity_fraction,
    )


def _envelope(
    train: list[AgingObservation], approved_limits: ExtrapolationLimits
) -> CalibrationValidityEnvelope:
    def values(name: str) -> list[float]:
        return [float(getattr(item, name)) for item in train]

    return CalibrationValidityEnvelope(
        product_revision=train[0].product_revision,
        temperature_min_c=min(values("cell_temperature_c")),
        temperature_max_c=max(values("cell_temperature_c")),
        depth_of_discharge_min=min(values("depth_of_discharge")),
        depth_of_discharge_max=max(values("depth_of_discharge")),
        mean_soc_min=min(values("mean_soc")),
        mean_soc_max=max(values("mean_soc")),
        charge_c_rate_min=min(values("max_charge_c_rate")),
        charge_c_rate_max=max(values("max_charge_c_rate")),
        discharge_c_rate_min=min(values("max_discharge_c_rate")),
        discharge_c_rate_max=max(values("max_discharge_c_rate")),
        training_maximum_elapsed_days=max(values("elapsed_days")),
        training_maximum_cycle_count=max(item.cycle_count for item in train),
        training_maximum_equivalent_full_cycles=max(values("equivalent_full_cycles")),
        training_maximum_absolute_throughput_ah=max(values("absolute_throughput_ah")),
        approved_extrapolation_limits=approved_limits,
    )
