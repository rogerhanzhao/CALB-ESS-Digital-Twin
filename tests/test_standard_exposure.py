from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from calb_ess_digital_twin.dispatch import (
    StandardExposurePlan,
    build_standard_exposure,
)
from calb_ess_digital_twin.dispatch.exposure_cli import main as exposure_cli_main


def _plan(**updates: object) -> StandardExposurePlan:
    values: dict[str, object] = {
        "standard_scenario_version": "scenario-V1",
        "code_revision": "1234567",
        "product_revision": "product-revision-001",
        "study_start_date": date(2024, 1, 1),
        "horizon_years": 2,
        "nominal_capacity_ah": 314.0,
        "cycles_per_operating_day": 0.5,
        "operating_availability_fraction": 0.9,
        "soc_window_min": 0.1,
        "soc_window_max": 0.9,
        "depth_of_discharge": 0.8,
        "cell_temperature_c": 25.0,
        "max_charge_c_rate": 0.5,
        "max_discharge_c_rate": 0.5,
    }
    values.update(updates)
    return StandardExposurePlan.model_validate(values)


def test_actual_calendar_days_drive_fractional_cycles_efc_and_throughput() -> None:
    artifact = build_standard_exposure(_plan())

    year_one = artifact.exposure_points[1]
    year_two = artifact.exposure_points[2]
    assert year_one.calendar_date == date(2025, 1, 1)
    assert year_one.elapsed_days == 366
    assert year_one.cycle_count == pytest.approx(164.7)
    assert year_one.equivalent_full_cycles == pytest.approx(131.76)
    assert year_one.absolute_throughput_ah == pytest.approx(82745.28)
    assert year_two.calendar_date == date(2026, 1, 1)
    assert year_two.elapsed_days == 731
    assert year_two.cycle_count == pytest.approx(328.95)


def test_conditions_are_derived_from_the_same_soc_window() -> None:
    artifact = build_standard_exposure(_plan())

    assert artifact.conditions.depth_of_discharge == 0.8
    assert artifact.conditions.mean_soc == pytest.approx(0.5)
    assert artifact.conditions.product_revision == "product-revision-001"
    assert artifact.throughput_basis == "nominal_cell_capacity"


def test_inconsistent_soc_window_and_dod_are_rejected() -> None:
    with pytest.raises(ValidationError, match="must equal"):
        _plan(depth_of_discharge=0.7)


def test_february_29_anniversary_uses_actual_calendar_dates() -> None:
    artifact = build_standard_exposure(
        _plan(study_start_date=date(2024, 2, 29), horizon_years=4)
    )

    assert artifact.exposure_points[1].calendar_date == date(2025, 2, 28)
    assert artifact.exposure_points[1].elapsed_days == 365
    assert artifact.exposure_points[4].calendar_date == date(2028, 2, 29)
    assert artifact.exposure_points[4].elapsed_days == 1461


def test_study_horizon_must_fit_supported_calendar_range() -> None:
    with pytest.raises(ValidationError, match="supported calendar range"):
        _plan(study_start_date=date(9999, 1, 1), horizon_years=1)


def test_initial_exposure_is_retained_and_new_exposure_is_added() -> None:
    artifact = build_standard_exposure(
        _plan(
            initial_elapsed_days=100,
            initial_absolute_throughput_ah=1000,
            initial_cycle_count=10.5,
            initial_equivalent_full_cycles=8,
        )
    )

    initial = artifact.exposure_points[0]
    year_one = artifact.exposure_points[1]
    assert initial.elapsed_days == 100
    assert initial.absolute_throughput_ah == 1000
    assert initial.cycle_count == 10.5
    assert initial.equivalent_full_cycles == 8
    assert year_one.elapsed_days == 466
    assert year_one.absolute_throughput_ah == pytest.approx(83745.28)


def test_zero_availability_adds_calendar_age_but_no_cycle_exposure() -> None:
    artifact = build_standard_exposure(_plan(operating_availability_fraction=0))

    final = artifact.exposure_points[-1]
    assert final.elapsed_days == 731
    assert final.cycle_count == 0
    assert final.equivalent_full_cycles == 0
    assert final.absolute_throughput_ah == 0


def test_cli_writes_non_overwriting_versioned_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan_path = tmp_path / "scenario-plan.yaml"
    artifact_path = tmp_path / "scenario-exposure.json"
    plan_path.write_text(
        yaml.safe_dump(_plan().model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-build-standard-exposure", str(plan_path), str(artifact_path)],
    )

    exit_code = exposure_cli_main()

    assert exit_code == 0
    artifact_text = artifact_path.read_text(encoding="utf-8")
    assert '"standard_scenario_version": "scenario-V1"' in artifact_text
    assert '"calendar_basis": "actual_calendar_days"' in artifact_text
