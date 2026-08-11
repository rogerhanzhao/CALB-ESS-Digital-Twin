"""Deterministic standard-scenario exposure trajectory generation."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from calb_ess_digital_twin.soh_engine.extrapolation import (
    ExposurePoint,
    StandardScenarioConditions,
)

SOC_TOLERANCE = 1e-9


class StandardExposurePlan(BaseModel):
    """Versioned constant-duty plan for one standard engineering scenario."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    standard_scenario_version: str = Field(min_length=1)
    code_revision: str = Field(min_length=7)
    product_revision: str = Field(min_length=1)
    study_start_date: date
    horizon_years: int = Field(ge=1)
    nominal_capacity_ah: float = Field(gt=0)
    cycles_per_operating_day: float = Field(ge=0)
    operating_availability_fraction: float = Field(ge=0, le=1)
    soc_window_min: float = Field(ge=0, le=1)
    soc_window_max: float = Field(ge=0, le=1)
    depth_of_discharge: float = Field(ge=0, le=1)
    cell_temperature_c: float
    max_charge_c_rate: float = Field(ge=0)
    max_discharge_c_rate: float = Field(ge=0)
    initial_elapsed_days: float = Field(default=0, ge=0)
    initial_absolute_throughput_ah: float = Field(default=0, ge=0)
    initial_cycle_count: float = Field(default=0, ge=0)
    initial_equivalent_full_cycles: float = Field(default=0, ge=0)

    @model_validator(mode="after")
    def soc_window_is_physical_and_consistent(self) -> StandardExposurePlan:
        if self.soc_window_max <= self.soc_window_min:
            raise ValueError("soc_window_max must be greater than soc_window_min")
        window_depth = self.soc_window_max - self.soc_window_min
        if abs(window_depth - self.depth_of_discharge) > SOC_TOLERANCE:
            raise ValueError("depth_of_discharge must equal soc_window_max - soc_window_min")
        if self.study_start_date.year + self.horizon_years > date.max.year:
            raise ValueError("study horizon exceeds the supported calendar range")
        return self


class StandardExposureArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    standard_scenario_version: str
    code_revision: str
    product_revision: str
    calendar_basis: Literal["actual_calendar_days"] = "actual_calendar_days"
    throughput_basis: Literal["nominal_cell_capacity"] = "nominal_cell_capacity"
    conditions: StandardScenarioConditions
    plan: StandardExposurePlan
    exposure_points: list[ExposurePoint]
    assumptions: tuple[str, ...]


def build_standard_exposure(plan: StandardExposurePlan) -> StandardExposureArtifact:
    """Generate annual cumulative exposure using actual calendar-day intervals."""

    points: list[ExposurePoint] = []
    for year in range(plan.horizon_years + 1):
        point_date = _anniversary(plan.study_start_date, year)
        study_elapsed_days = float((point_date - plan.study_start_date).days)
        operating_days = study_elapsed_days * plan.operating_availability_fraction
        added_cycles = operating_days * plan.cycles_per_operating_day
        added_efc = added_cycles * plan.depth_of_discharge
        added_throughput_ah = 2 * plan.nominal_capacity_ah * added_efc
        points.append(
            ExposurePoint(
                year=year,
                calendar_date=point_date,
                elapsed_days=plan.initial_elapsed_days + study_elapsed_days,
                absolute_throughput_ah=(
                    plan.initial_absolute_throughput_ah + added_throughput_ah
                ),
                cycle_count=plan.initial_cycle_count + added_cycles,
                equivalent_full_cycles=plan.initial_equivalent_full_cycles + added_efc,
            )
        )

    conditions = StandardScenarioConditions(
        product_revision=plan.product_revision,
        cell_temperature_c=plan.cell_temperature_c,
        depth_of_discharge=plan.depth_of_discharge,
        mean_soc=(plan.soc_window_min + plan.soc_window_max) / 2,
        max_charge_c_rate=plan.max_charge_c_rate,
        max_discharge_c_rate=plan.max_discharge_c_rate,
    )
    return StandardExposureArtifact(
        standard_scenario_version=plan.standard_scenario_version,
        code_revision=plan.code_revision,
        product_revision=plan.product_revision,
        conditions=conditions,
        plan=plan,
        exposure_points=points,
        assumptions=(
            "constant cycles per operating day over each calendar interval",
            "operating availability is applied uniformly to actual calendar days",
            "one scheduled cycle contributes DoD equivalent full cycles",
            "absolute Ah throughput uses two times nominal capacity times EFC",
            "capacity fade, auxiliary energy, RTE, and dispatch constraints are not included",
        ),
    )


def _anniversary(start: date, years: int) -> date:
    target_year = start.year + years
    try:
        return start.replace(year=target_year)
    except ValueError:
        # A 29-Feb study uses 28-Feb as its anniversary in non-leap years.
        return start.replace(year=target_year, day=28)
