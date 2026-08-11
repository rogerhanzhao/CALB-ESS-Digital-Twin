"""Build auditable SOH calibration observations from accepted cycle evidence."""

from __future__ import annotations

import math
from typing import Literal

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, model_validator

from calb_ess_digital_twin.cell_database.cycle_metrics import CycleMetricReport

from .calibration import AgingObservation, SplitRole


class RevisionObservationSelection(BaseModel):
    """Engineering choices that cannot be truthfully inferred from tester rows."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    dataset_revision_id: str = Field(min_length=1)
    product_revision: str = Field(min_length=1)
    sample_id: str = Field(min_length=1)
    split: SplitRole
    included_cycle_indices: tuple[int, ...] = Field(min_length=1)
    reference_capacity_ah: float = Field(gt=0)
    nominal_capacity_ah: float = Field(gt=0)
    depth_of_discharge: float = Field(gt=0, le=1)
    mean_soc: float = Field(ge=0, le=1)
    prior_elapsed_days: float = Field(ge=0)
    prior_cycle_count: int = Field(ge=0)
    prior_absolute_throughput_ah: float = Field(ge=0)
    prior_equivalent_full_cycles: float = Field(ge=0)
    capacity_source: Literal["discharge_capacity_ah"] = "discharge_capacity_ah"

    @model_validator(mode="after")
    def selected_cycles_are_unique(self) -> RevisionObservationSelection:
        if len(self.included_cycle_indices) != len(set(self.included_cycle_indices)):
            raise ValueError("included_cycle_indices must be unique")
        return self


def build_revision_observations(
    canonical: pd.DataFrame,
    metrics: CycleMetricReport,
    selection: RevisionObservationSelection,
) -> list[AgingObservation]:
    """Create selected observations without inventing test-plan or split semantics."""

    required = {"timestamp", "current_a", "cell_temperature_c", "cycle_index"}
    missing = sorted(required - set(canonical.columns))
    if missing:
        raise ValueError(f"canonical dataset is missing calibration columns: {', '.join(missing)}")
    if canonical.empty:
        raise ValueError("canonical dataset contains no rows")
    if not math.isclose(
        metrics.nominal_capacity_ah,
        selection.nominal_capacity_ah,
        rel_tol=1e-9,
        abs_tol=1e-9,
    ):
        raise ValueError("selection nominal_capacity_ah does not match cycle-metric evidence")

    frame = canonical.copy(deep=True)
    frame["_timestamp"] = pd.to_datetime(
        frame["timestamp"], errors="raise", format="ISO8601", utc=True
    )
    for column in ("current_a", "cell_temperature_c", "cycle_index"):
        frame[column] = pd.to_numeric(frame[column], errors="raise")
        if not frame[column].map(math.isfinite).all():
            raise ValueError(f"canonical {column} must contain finite values")
    if (frame["cycle_index"] % 1 != 0).any():
        raise ValueError("canonical cycle_index must contain integers")

    metric_by_cycle = {item.cycle_index: item for item in metrics.cycles}
    selected = set(selection.included_cycle_indices)
    absent = sorted(selected - set(metric_by_cycle))
    if absent:
        raise ValueError(f"selected cycle metrics are unavailable: {absent}")
    partial = sorted(index for index in selected if metric_by_cycle[index].is_partial)
    if partial:
        raise ValueError(f"partial cycles cannot be calibration observations: {partial}")

    test_started_at = frame["_timestamp"].min()
    cumulative_throughput = selection.prior_absolute_throughput_ah
    cumulative_efc = selection.prior_equivalent_full_cycles
    completed_cycles = selection.prior_cycle_count
    observations: list[AgingObservation] = []
    for metric in metrics.cycles:
        cumulative_throughput += metric.absolute_throughput_ah
        cumulative_efc += metric.equivalent_full_cycles
        if not metric.is_partial:
            completed_cycles += 1
        if metric.cycle_index not in selected:
            continue
        group = frame.loc[frame["cycle_index"] == metric.cycle_index]
        if group.empty:
            raise ValueError(f"canonical rows are unavailable for cycle {metric.cycle_index}")
        elapsed_days = selection.prior_elapsed_days + float(
            (group["_timestamp"].max() - test_started_at).total_seconds() / 86400
        )
        measured_capacity_fraction = (
            metric.discharge_capacity_ah / selection.reference_capacity_ah
        )
        if measured_capacity_fraction <= 0:
            raise ValueError(f"cycle {metric.cycle_index} has no measured discharge capacity")
        current = group["current_a"].astype(float)
        observations.append(
            AgingObservation(
                observation_id=(
                    f"{selection.dataset_revision_id}:cycle:{metric.cycle_index}"
                ),
                dataset_revision_id=selection.dataset_revision_id,
                product_revision=selection.product_revision,
                sample_id=selection.sample_id,
                split=selection.split,
                elapsed_days=elapsed_days,
                absolute_throughput_ah=cumulative_throughput,
                measured_capacity_fraction=measured_capacity_fraction,
                cell_temperature_c=float(group["cell_temperature_c"].mean()),
                depth_of_discharge=selection.depth_of_discharge,
                mean_soc=selection.mean_soc,
                max_charge_c_rate=max(float(current.max()), 0.0)
                / selection.nominal_capacity_ah,
                max_discharge_c_rate=max(float(-current.min()), 0.0)
                / selection.nominal_capacity_ah,
                cycle_count=completed_cycles,
                equivalent_full_cycles=cumulative_efc,
            )
        )
    return observations
