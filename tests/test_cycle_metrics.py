from __future__ import annotations

import pandas as pd
import pytest

from calb_ess_digital_twin.cell_database import (
    CycleMetricPolicy,
    StepRole,
    derive_cycle_metrics,
)


def _canonical_cycle() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp": [
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T01:00:00+00:00",
                "2026-01-01T02:00:00+00:00",
                "2026-01-01T03:00:00+00:00",
                "2026-01-01T04:00:00+00:00",
                "2026-01-01T05:00:00+00:00",
            ],
            "voltage_v": [3.2] * 6,
            "current_a": [1.0, 1.0, 0.0, -0.75, -0.75, 0.0],
            "capacity_ah": [0.0, 1.0, 1.5, 0.5, 1.5, 1.5],
            "cycle_index": [1] * 6,
            "step_index": [1, 1, 2, 3, 3, 4],
        }
    )


def _policy() -> CycleMetricPolicy:
    return CycleMetricPolicy(
        nominal_capacity_ah=2.0,
        step_roles={
            1: StepRole.CHARGE,
            2: StepRole.REST,
            3: StepRole.DISCHARGE,
            4: StepRole.REST,
        },
        full_cycle_sequence=(
            StepRole.CHARGE,
            StepRole.REST,
            StepRole.DISCHARGE,
            StepRole.REST,
        ),
    )


def test_derives_measured_capacity_energy_throughput_and_efficiency() -> None:
    source = _canonical_cycle()
    before = source.copy(deep=True)

    report = derive_cycle_metrics(source, _policy())

    cycle = report.cycles[0]
    assert cycle.is_partial is False
    assert cycle.charge_capacity_ah == pytest.approx(1.5)
    assert cycle.discharge_capacity_ah == pytest.approx(1.5)
    assert cycle.absolute_throughput_ah == pytest.approx(3.0)
    assert cycle.charge_energy_wh == pytest.approx(4.8)
    assert cycle.discharge_energy_wh == pytest.approx(4.8)
    assert cycle.coulombic_efficiency == pytest.approx(1.0)
    assert cycle.energy_efficiency == pytest.approx(1.0)
    assert cycle.equivalent_full_cycles == pytest.approx(0.75)
    assert cycle.tester_capacity_span_ah == pytest.approx(1.5)
    assert report.total_equivalent_full_cycles == pytest.approx(0.75)
    pd.testing.assert_frame_equal(source, before)


def test_missing_required_rest_segment_marks_cycle_partial() -> None:
    source = _canonical_cycle().iloc[:-1].copy()

    report = derive_cycle_metrics(source, _policy())

    assert report.full_cycle_count == 0
    assert report.partial_cycle_count == 1
    assert report.cycles[0].is_partial is True
    assert report.cycles[0].observed_sequence == (
        StepRole.CHARGE,
        StepRole.REST,
        StepRole.DISCHARGE,
    )


def test_unknown_step_is_not_silently_interpreted() -> None:
    source = _canonical_cycle()
    source.loc[2, "step_index"] = 99

    with pytest.raises(ValueError, match="absent from test plan"):
        derive_cycle_metrics(source, _policy())


def test_non_monotonic_timestamps_are_rejected() -> None:
    source = _canonical_cycle()
    source.loc[3, "timestamp"] = "2026-01-01T01:30:00+00:00"

    with pytest.raises(ValueError, match="strictly increasing"):
        derive_cycle_metrics(source, _policy())


def test_decreasing_cycle_index_is_rejected() -> None:
    source = _canonical_cycle()
    source.loc[4:, "cycle_index"] = 0

    with pytest.raises(ValueError, match="cycle_index must not decrease"):
        derive_cycle_metrics(source, _policy())


def test_fractional_step_index_is_rejected_without_truncation() -> None:
    source = _canonical_cycle()
    source["step_index"] = source["step_index"].astype(float)
    source.loc[2, "step_index"] = 2.5

    with pytest.raises(ValueError, match="step_index must contain integers"):
        derive_cycle_metrics(source, _policy())


def test_nominal_capacity_is_required_for_equivalent_full_cycles() -> None:
    with pytest.raises(ValueError, match="greater than 0"):
        CycleMetricPolicy(
            nominal_capacity_ah=0,
            step_roles={1: StepRole.CHARGE},
            full_cycle_sequence=(StepRole.CHARGE,),
        )
