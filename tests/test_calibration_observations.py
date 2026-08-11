from datetime import UTC, datetime

import pandas as pd
import pytest

from calb_ess_digital_twin.cell_database.cycle_metrics import (
    CycleMetric,
    CycleMetricReport,
    StepRole,
)
from calb_ess_digital_twin.soh_engine.calibration import SplitRole
from calb_ess_digital_twin.soh_engine.calibration_observations import (
    RevisionObservationSelection,
    build_revision_observations,
)


def _canonical() -> pd.DataFrame:
    return pd.DataFrame({
        "timestamp": ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z"],
        "current_a": [100.0, -100.0, 120.0, -120.0],
        "cell_temperature_c": [24.0, 26.0, 28.0, 30.0],
        "cycle_index": [1, 1, 2, 2],
    })


def _metric(index: int, discharge: float, throughput: float, *, partial: bool = False) -> CycleMetric:
    return CycleMetric(
        cycle_index=index,
        started_at=datetime(2026, 1, index, tzinfo=UTC).isoformat(),
        ended_at=datetime(2026, 1, index, 1, tzinfo=UTC).isoformat(),
        duration_s=3600,
        observed_sequence=(StepRole.CHARGE, StepRole.DISCHARGE),
        is_partial=partial,
        charge_capacity_ah=discharge,
        discharge_capacity_ah=discharge,
        absolute_throughput_ah=throughput,
        charge_energy_wh=100,
        discharge_energy_wh=90,
        coulombic_efficiency=1,
        energy_efficiency=0.9,
        equivalent_full_cycles=throughput / 200,
        tester_capacity_span_ah=None,
    )


def _report(*metrics: CycleMetric) -> CycleMetricReport:
    return CycleMetricReport(
        nominal_capacity_ah=100,
        cycle_count=len(metrics),
        full_cycle_count=sum(not item.is_partial for item in metrics),
        partial_cycle_count=sum(item.is_partial for item in metrics),
        total_absolute_throughput_ah=sum(item.absolute_throughput_ah for item in metrics),
        total_equivalent_full_cycles=sum(item.equivalent_full_cycles for item in metrics),
        cycles=list(metrics),
    )


def _selection(**updates) -> RevisionObservationSelection:
    values = {
        "dataset_revision_id": "revision-1",
        "product_revision": "R1",
        "sample_id": "cell-1",
        "split": SplitRole.TRAIN,
        "included_cycle_indices": (2,),
        "reference_capacity_ah": 100,
        "nominal_capacity_ah": 100,
        "depth_of_discharge": 0.9,
        "mean_soc": 0.5,
        "prior_elapsed_days": 10,
        "prior_cycle_count": 20,
        "prior_absolute_throughput_ah": 4000,
        "prior_equivalent_full_cycles": 20,
    }
    values.update(updates)
    return RevisionObservationSelection(**values)


def test_builds_observation_from_selected_full_cycle_and_explicit_engineering_policy():
    observations = build_revision_observations(
        _canonical(), _report(_metric(1, 98, 200), _metric(2, 95, 190)), _selection()
    )
    assert len(observations) == 1
    item = observations[0]
    assert item.measured_capacity_fraction == pytest.approx(0.95)
    assert item.absolute_throughput_ah == pytest.approx(4390)
    assert item.equivalent_full_cycles == pytest.approx(21.95)
    assert item.cycle_count == 22
    assert item.elapsed_days == pytest.approx(11 + 1 / 24)
    assert item.cell_temperature_c == pytest.approx(29)
    assert item.max_charge_c_rate == pytest.approx(1.2)
    assert item.max_discharge_c_rate == pytest.approx(1.2)


def test_rejects_partial_or_absent_selected_cycles():
    with pytest.raises(ValueError, match="partial cycles"):
        build_revision_observations(_canonical(), _report(_metric(2, 95, 190, partial=True)), _selection())
    with pytest.raises(ValueError, match="unavailable"):
        build_revision_observations(_canonical(), _report(_metric(1, 98, 200)), _selection())


def test_selection_requires_explicit_prior_exposure_and_unique_cycles():
    with pytest.raises(ValueError, match="unique"):
        _selection(included_cycle_indices=(2, 2))


def test_nominal_capacity_must_match_the_revision_metric_policy():
    with pytest.raises(ValueError, match="nominal_capacity_ah"):
        build_revision_observations(
            _canonical(), _report(_metric(1, 98, 200)), _selection(nominal_capacity_ah=101)
        )
