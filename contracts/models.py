"""Single source of truth for simulation job and result payloads.

Contract versions identify a payload shape, not a release milestone. A required field addition
is therefore a breaking change and increments the major version. Job and result payloads evolve
independently: changing one does not force a cosmetic version bump in the other.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

SOC_TOLERANCE = 1e-9


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ScenarioInput(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    chemistry: Literal["LFP"] = "LFP"
    cell_param_set_version: str | None = Field(default=None, min_length=1)
    horizon_years: int = Field(ge=1, le=25)
    cycles_per_day: float = Field(ge=0, le=3)
    depth_of_discharge: float = Field(ge=0, le=1)
    soc_window_min: float = Field(ge=0, le=1)
    soc_window_max: float = Field(ge=0, le=1)
    ambient_temperature_c: float = Field(ge=-20, le=60)
    initial_soc: float = Field(ge=0, le=1)
    end_of_life_fraction: float = Field(ge=0.5, le=0.95)

    @model_validator(mode="after")
    def scenario_is_physically_consistent(self) -> ScenarioInput:
        if self.cycles_per_day > 0 and self.depth_of_discharge == 0:
            raise ValueError("depth_of_discharge must be positive when cycles_per_day is positive")
        if self.soc_window_min >= self.soc_window_max:
            raise ValueError("soc_window_min must be strictly below soc_window_max")
        # Physical fractions are decimal measurements. Without a tolerance, IEEE 754 makes
        # 0.95 - 0.05 slightly less than 0.9 and rejects an ordinary 5%-95% / 90% DoD cycle.
        if self.depth_of_discharge > self.soc_window_max - self.soc_window_min + SOC_TOLERANCE:
            raise ValueError("depth_of_discharge cannot exceed the declared SOC window")
        if not (
            self.soc_window_min - SOC_TOLERANCE
            <= self.initial_soc
            <= self.soc_window_max + SOC_TOLERANCE
        ):
            raise ValueError("initial_soc must lie within the declared SOC window")
        return self


class JobPayload(StrictModel):
    contract_version: Literal["3.0"] = "3.0"
    job_id: UUID
    scenario_id: UUID
    user_id: str = Field(min_length=1, max_length=200)
    engine: Literal[
        "demo", "stub", "pybamm-spme", "semi-empirical", "standard-study"
    ]
    model_version: str = Field(min_length=1)
    code_revision: str = Field(min_length=7, max_length=64)
    scenario: ScenarioInput | None = None
    standard_study_request: dict[str, Any] | None = None
    submitted_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def numerical_engines_require_parameters(self) -> JobPayload:
        if self.engine == "standard-study":
            if self.scenario is not None:
                raise ValueError("standard-study jobs must use only their versioned study request")
            if self.standard_study_request is None:
                raise ValueError("standard-study jobs require standard_study_request")
            return self
        if self.scenario is None:
            raise ValueError("scenario is required for non-standard-study jobs")
        if self.standard_study_request is not None:
            raise ValueError("standard_study_request is only valid for standard-study jobs")
        if (
            self.engine in {"pybamm-spme", "semi-empirical"}
            and self.scenario.cell_param_set_version is None
        ):
            raise ValueError("numerical engines require cell_param_set_version")
        return self


class ResultPoint(StrictModel):
    year: float = Field(ge=0)
    soh: float = Field(ge=0, le=1.1)
    resistance_growth: float = Field(ge=0)
    cumulative_throughput_mwh: float = Field(ge=0)


class Uncertainty(StrictModel):
    confidence_level: float = Field(gt=0, lt=1)
    source: Literal[
        "parameter_uncertainty",
        "sample_variance",
        "monte_carlo",
        "extrapolation_error",
        "combined",
        "not_available",
    ]
    lower_soh: float | None = Field(default=None, ge=0, le=1.1)
    upper_soh: float | None = Field(default=None, ge=0, le=1.1)

    @model_validator(mode="after")
    def bounds_are_ordered(self) -> Uncertainty:
        if (
            self.lower_soh is not None
            and self.upper_soh is not None
            and self.lower_soh > self.upper_soh
        ):
            raise ValueError("lower_soh must not exceed upper_soh")
        return self


class RunResult(StrictModel):
    contract_version: Literal["2.0"] = "2.0"
    job_id: UUID
    engine: Literal[
        "demo", "stub", "pybamm-spme", "semi-empirical", "standard-study"
    ]
    model_version: str
    code_revision: str
    status: Literal["completed", "failed", "cancelled"]
    points: list[ResultPoint] = Field(default_factory=list)
    end_soh: float | None = Field(default=None, ge=0, le=1.1)
    within_validity_envelope: bool | None = None
    uncertainty: Uncertainty
    metrics: dict[str, float] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    artifact_checksums: dict[str, str] = Field(default_factory=dict)
    completed_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
