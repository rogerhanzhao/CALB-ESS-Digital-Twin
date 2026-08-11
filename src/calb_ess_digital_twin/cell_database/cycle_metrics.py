"""Derived cycle-ageing metrics from an accepted canonical dataset revision."""

from __future__ import annotations

import math
from datetime import datetime
from enum import StrEnum

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, field_validator


class StepRole(StrEnum):
    CHARGE = "charge"
    REST = "rest"
    DISCHARGE = "discharge"


class CycleMetricPolicy(BaseModel):
    """Versioned test-plan interpretation; no product value is inferred."""

    model_config = ConfigDict(extra="forbid")

    nominal_capacity_ah: float = Field(gt=0)
    step_roles: dict[int, StepRole]
    full_cycle_sequence: tuple[StepRole, ...] = Field(min_length=1)

    @field_validator("step_roles")
    @classmethod
    def step_roles_are_not_empty(cls, value: dict[int, StepRole]) -> dict[int, StepRole]:
        if not value:
            raise ValueError("step_roles must come from a versioned test plan")
        return value


class CycleMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cycle_index: int
    started_at: str
    ended_at: str
    duration_s: float = Field(ge=0)
    observed_sequence: tuple[StepRole, ...]
    is_partial: bool
    charge_capacity_ah: float = Field(ge=0)
    discharge_capacity_ah: float = Field(ge=0)
    absolute_throughput_ah: float = Field(ge=0)
    charge_energy_wh: float = Field(ge=0)
    discharge_energy_wh: float = Field(ge=0)
    coulombic_efficiency: float | None
    energy_efficiency: float | None
    equivalent_full_cycles: float = Field(ge=0)
    tester_capacity_span_ah: float | None = Field(default=None, ge=0)


class CycleMetricReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = "V0.2"
    nominal_capacity_ah: float
    cycle_count: int
    full_cycle_count: int
    partial_cycle_count: int
    total_absolute_throughput_ah: float
    total_equivalent_full_cycles: float
    cycles: list[CycleMetric]


_REQUIRED_COLUMNS = {
    "timestamp",
    "voltage_v",
    "current_a",
    "cycle_index",
    "step_index",
}


def derive_cycle_metrics(
    canonical: pd.DataFrame, policy: CycleMetricPolicy
) -> CycleMetricReport:
    """Integrate measured current/voltage per cycle without mutating input data."""

    missing = sorted(_REQUIRED_COLUMNS - set(canonical.columns))
    if missing:
        raise ValueError(f"canonical dataset is missing required columns: {', '.join(missing)}")
    if canonical.empty:
        raise ValueError("canonical dataset contains no rows")

    frame = canonical.copy(deep=True)
    for column in ("voltage_v", "current_a", "cycle_index", "step_index"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
        if frame[column].isna().any() or not frame[column].map(math.isfinite).all():
            raise ValueError(f"canonical {column} must contain finite numeric values")
    for column in ("cycle_index", "step_index"):
        if (frame[column] % 1 != 0).any():
            raise ValueError(f"canonical {column} must contain integers")
    if (frame["cycle_index"].diff().dropna() < 0).any():
        raise ValueError("canonical cycle_index must not decrease")

    for value in frame["timestamp"]:
        parsed = datetime.fromisoformat(str(value))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("canonical timestamps must include a timezone")
    frame["_timestamp"] = pd.to_datetime(
        frame["timestamp"], errors="raise", format="ISO8601", utc=True
    )
    if frame["_timestamp"].duplicated().any() or (frame["_timestamp"].diff().dropna() <= pd.Timedelta(0)).any():
        raise ValueError("canonical timestamps must be unique and strictly increasing")

    cycles: list[CycleMetric] = []
    for cycle_value, group in frame.groupby("cycle_index", sort=False):
        cycles.append(_derive_one_cycle(group, int(cycle_value), policy))

    throughput = sum(cycle.absolute_throughput_ah for cycle in cycles)
    efc = sum(cycle.equivalent_full_cycles for cycle in cycles)
    full_count = sum(not cycle.is_partial for cycle in cycles)
    return CycleMetricReport(
        nominal_capacity_ah=policy.nominal_capacity_ah,
        cycle_count=len(cycles),
        full_cycle_count=full_count,
        partial_cycle_count=len(cycles) - full_count,
        total_absolute_throughput_ah=throughput,
        total_equivalent_full_cycles=efc,
        cycles=cycles,
    )


def _derive_one_cycle(
    group: pd.DataFrame, cycle_index: int, policy: CycleMetricPolicy
) -> CycleMetric:
    unknown_steps = sorted(set(group["step_index"].astype(int)) - set(policy.step_roles))
    if unknown_steps:
        raise ValueError(
            f"cycle {cycle_index} contains step_index values absent from test plan: {unknown_steps}"
        )

    observed_roles = [policy.step_roles[int(step)] for step in group["step_index"]]
    observed_sequence = tuple(
        role for position, role in enumerate(observed_roles) if position == 0 or role != observed_roles[position - 1]
    )
    is_partial = observed_sequence != policy.full_cycle_sequence

    elapsed_hours = group["_timestamp"].diff().dt.total_seconds().fillna(0.0) / 3600.0
    current = group["current_a"].astype(float)
    voltage = group["voltage_v"].astype(float)
    positive_current = current.clip(lower=0.0)
    negative_current = (-current).clip(lower=0.0)
    positive_power = (voltage * current).clip(lower=0.0)
    negative_power = (-(voltage * current)).clip(lower=0.0)

    charge_ah = _trapezoid(positive_current, elapsed_hours)
    discharge_ah = _trapezoid(negative_current, elapsed_hours)
    charge_wh = _trapezoid(positive_power, elapsed_hours)
    discharge_wh = _trapezoid(negative_power, elapsed_hours)
    throughput_ah = charge_ah + discharge_ah

    tester_span: float | None = None
    if "capacity_ah" in group and group["capacity_ah"].notna().any():
        tester_span = float(group["capacity_ah"].max() - group["capacity_ah"].min())

    return CycleMetric(
        cycle_index=cycle_index,
        started_at=group["_timestamp"].iloc[0].isoformat(),
        ended_at=group["_timestamp"].iloc[-1].isoformat(),
        duration_s=float(
            (group["_timestamp"].iloc[-1] - group["_timestamp"].iloc[0]).total_seconds()
        ),
        observed_sequence=observed_sequence,
        is_partial=is_partial,
        charge_capacity_ah=charge_ah,
        discharge_capacity_ah=discharge_ah,
        absolute_throughput_ah=throughput_ah,
        charge_energy_wh=charge_wh,
        discharge_energy_wh=discharge_wh,
        coulombic_efficiency=discharge_ah / charge_ah if charge_ah > 0 else None,
        energy_efficiency=discharge_wh / charge_wh if charge_wh > 0 else None,
        equivalent_full_cycles=throughput_ah / (2 * policy.nominal_capacity_ah),
        tester_capacity_span_ah=tester_span,
    )


def _trapezoid(values: pd.Series, elapsed_hours: pd.Series) -> float:
    previous = values.shift(1)
    interval_average = (values + previous) / 2
    return float((interval_average.fillna(0.0) * elapsed_hours).sum())
