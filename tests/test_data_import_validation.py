from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import pytest
import yaml
from pydantic import ValidationError

from calb_ess_digital_twin.cell_database import (
    ColumnMapping,
    CurrentSign,
    CycleMetricPolicy,
    ImportManifest,
    StepRole,
    ValidationLevel,
    ValidationPolicy,
    validate_csv_import,
)
from calb_ess_digital_twin.cell_database import (
    TestType as CellTestType,
)
from calb_ess_digital_twin.cell_database.import_cli import main as import_cli_main
from calb_ess_digital_twin.cell_database.import_validation import file_sha256


def _cycle_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Time": [
                "2026-01-01T00:00:00+08:00",
                "2026-01-01T00:00:01+08:00",
                "2026-01-01T00:00:02+08:00",
            ],
            "Elapsed_ms": [0, 1000, 2000],
            "Voltage_mV": [3200, 3210, 3190],
            "Current_A": [1.0, 0.0, -1.0],
            "Cell_K": [298.15, 298.15, 298.25],
            "Ambient_C": [25.0, 25.0, 25.0],
            "Capacity_mAh": [0.0, 0.0002, 0.0004],
            "Cycle": [1, 1, 1],
            "Step": [1, 2, 3],
        }
    )


def _mappings() -> list[ColumnMapping]:
    values = [
        ("Time", "timestamp", "iso8601"),
        ("Elapsed_ms", "elapsed_time_s", "ms"),
        ("Voltage_mV", "voltage_v", "mV"),
        ("Current_A", "current_a", "A"),
        ("Cell_K", "cell_temperature_c", "K"),
        ("Ambient_C", "ambient_temperature_c", "degC"),
        ("Capacity_mAh", "capacity_ah", "mAh"),
        ("Cycle", "cycle_index", "integer"),
        ("Step", "step_index", "integer"),
    ]
    return [
        ColumnMapping(source_column=source, canonical_column=canonical, source_unit=unit)
        for source, canonical, unit in values
    ]


def _manifest(path: Path, **updates: object) -> ImportManifest:
    values: dict[str, object] = {
        "product_id": "product-revision-001",
        "sample_id": "sample-001",
        "batch_code": "batch-001",
        "test_type": CellTestType.CYCLE_AGING,
        "source_lab": "approved-lab",
        "equipment_id": "channel-001",
        "test_started_at": datetime.fromisoformat("2025-12-31T23:59:00+08:00"),
        "test_ended_at": datetime.fromisoformat("2026-01-01T00:01:00+08:00"),
        "file_name": path.name,
        "file_sha256": file_sha256(path),
        "operator": "operator-001",
    }
    values.update(updates)
    return ImportManifest.model_validate(values)


def _policy() -> ValidationPolicy:
    return ValidationPolicy(
        voltage_min_v=2.0,
        voltage_max_v=4.0,
        absolute_current_max_a=10.0,
        temperature_min_c=0.0,
        temperature_max_c=60.0,
    )


def _write_csv(tmp_path: Path, frame: pd.DataFrame | None = None) -> Path:
    path = tmp_path / "measured.csv"
    (frame if frame is not None else _cycle_frame()).to_csv(path, index=False)
    return path


def test_valid_cycle_import_normalizes_units_without_changing_source(tmp_path: Path) -> None:
    path = _write_csv(tmp_path)
    before = path.read_bytes()

    imported = validate_csv_import(path, _manifest(path), _mappings(), _policy())

    assert imported.report.outcome == ValidationLevel.PASS
    assert imported.normalized is not None
    assert imported.normalized["voltage_v"].tolist() == [3.2, 3.21, 3.19]
    assert imported.normalized["elapsed_time_s"].tolist() == [0.0, 1.0, 2.0]
    assert imported.normalized["cell_temperature_c"].iloc[0] == pytest.approx(25.0)
    assert path.read_bytes() == before
    assert "voltage_v: mV -> V" in imported.report.applied_conversions


def test_checksum_mismatch_rejects_and_returns_no_normalized_data(tmp_path: Path) -> None:
    path = _write_csv(tmp_path)
    manifest = _manifest(path, file_sha256="0" * 64)

    imported = validate_csv_import(path, manifest, _mappings(), _policy())

    assert imported.report.outcome == ValidationLevel.REJECT
    assert imported.normalized is None
    assert {issue.code for issue in imported.report.issues} == {"checksum_mismatch"}


def test_missing_test_specific_column_is_rejected(tmp_path: Path) -> None:
    path = _write_csv(tmp_path)
    mappings = [item for item in _mappings() if item.canonical_column != "cycle_index"]

    imported = validate_csv_import(path, _manifest(path), mappings, _policy())

    assert imported.report.outcome == ValidationLevel.REJECT
    assert "missing_required_column" in {issue.code for issue in imported.report.issues}


def test_limits_are_injected_and_out_of_bounds_measurement_is_rejected(tmp_path: Path) -> None:
    frame = _cycle_frame()
    frame.loc[1, "Voltage_mV"] = 4500
    path = _write_csv(tmp_path, frame)

    imported = validate_csv_import(path, _manifest(path), _mappings(), _policy())

    issue = next(issue for issue in imported.report.issues if issue.code == "physical_limit_exceeded")
    assert imported.report.outcome == ValidationLevel.REJECT
    assert issue.row == 1
    assert issue.column == "voltage_v"


def test_irregular_sampling_is_warning_and_remains_reviewable(tmp_path: Path) -> None:
    frame = _cycle_frame()
    frame.loc[3] = frame.loc[2]
    frame.loc[3, "Time"] = "2026-01-01T00:00:06+08:00"
    frame.loc[3, "Elapsed_ms"] = 6000
    frame.loc[3, "Step"] = 4
    path = _write_csv(tmp_path, frame)

    imported = validate_csv_import(path, _manifest(path), _mappings(), _policy())

    assert imported.report.outcome == ValidationLevel.WARNING
    assert imported.normalized is not None
    assert {issue.code for issue in imported.report.issues} == {
        "irregular_sampling",
        "sampling_gap",
    }


def test_declared_discharge_positive_current_is_converted_and_recorded(tmp_path: Path) -> None:
    path = _write_csv(tmp_path)
    manifest = _manifest(path, current_sign=CurrentSign.DISCHARGE_POSITIVE)

    imported = validate_csv_import(path, manifest, _mappings(), _policy())

    assert imported.normalized is not None
    assert imported.normalized["current_a"].tolist() == [-1.0, -0.0, 1.0]
    assert "current_a: discharge_positive -> charge_positive" in (
        imported.report.applied_conversions
    )


def test_manifest_rejects_naive_test_timestamps(tmp_path: Path) -> None:
    path = _write_csv(tmp_path)

    with pytest.raises(ValidationError, match="must include a timezone"):
        _manifest(path, test_started_at="2026-01-01T00:00:00")


def test_measurement_timestamp_without_timezone_is_rejected(tmp_path: Path) -> None:
    frame = _cycle_frame()
    frame.loc[1, "Time"] = "2026-01-01T00:00:01"
    path = _write_csv(tmp_path, frame)

    imported = validate_csv_import(path, _manifest(path), _mappings(), _policy())

    assert imported.report.outcome == ValidationLevel.REJECT
    assert "invalid_timestamp" in {issue.code for issue in imported.report.issues}


def test_missing_required_numeric_value_is_rejected(tmp_path: Path) -> None:
    frame = _cycle_frame()
    frame.loc[1, "Capacity_mAh"] = None
    path = _write_csv(tmp_path, frame)

    imported = validate_csv_import(path, _manifest(path), _mappings(), _policy())

    matching = [issue for issue in imported.report.issues if issue.code == "missing_required_value"]
    assert imported.report.outcome == ValidationLevel.REJECT
    assert any(issue.row == 1 and issue.column == "capacity_ah" for issue in matching)


def test_fractional_cycle_index_is_rejected(tmp_path: Path) -> None:
    frame = _cycle_frame()
    frame["Cycle"] = frame["Cycle"].astype(float)
    frame.loc[1, "Cycle"] = 1.5
    path = _write_csv(tmp_path, frame)

    imported = validate_csv_import(path, _manifest(path), _mappings(), _policy())

    assert imported.report.outcome == ValidationLevel.REJECT
    assert "non_integer_index" in {issue.code for issue in imported.report.issues}


def test_unreadable_source_returns_structured_rejection(tmp_path: Path) -> None:
    existing = _write_csv(tmp_path)
    manifest = _manifest(existing, file_name="missing.csv")

    imported = validate_csv_import(tmp_path / "missing.csv", manifest, _mappings(), _policy())

    assert imported.report.outcome == ValidationLevel.REJECT
    assert imported.normalized is None
    assert imported.report.issues[0].code == "source_unreadable"


def test_cli_creates_new_revision_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _write_csv(tmp_path)
    configuration = tmp_path / "configuration.yaml"
    output = tmp_path / "revision-001"
    payload = {
        "manifest": _manifest(source).model_dump(mode="json"),
        "mappings": [mapping.model_dump(mode="json") for mapping in _mappings()],
        "policy": _policy().model_dump(mode="json"),
        "cycle_metric_policy": CycleMetricPolicy(
            nominal_capacity_ah=2.0,
            step_roles={1: StepRole.CHARGE, 2: StepRole.REST, 3: StepRole.DISCHARGE},
            full_cycle_sequence=(StepRole.CHARGE, StepRole.REST, StepRole.DISCHARGE),
        ).model_dump(mode="json"),
    }
    configuration.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-validate-test-data", str(source), str(configuration), str(output)],
    )

    exit_code = import_cli_main()

    assert exit_code == 0
    assert (output / "canonical.csv").is_file()
    assert (output / "validation-report.json").is_file()
    assert (output / "cycle-metrics.json").is_file()


def test_cli_does_not_leave_partial_revision_when_metric_derivation_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _write_csv(tmp_path)
    configuration = tmp_path / "configuration.yaml"
    output = tmp_path / "revision-invalid"
    payload = {
        "manifest": _manifest(source).model_dump(mode="json"),
        "mappings": [mapping.model_dump(mode="json") for mapping in _mappings()],
        "policy": _policy().model_dump(mode="json"),
        "cycle_metric_policy": CycleMetricPolicy(
            nominal_capacity_ah=2.0,
            step_roles={1: StepRole.CHARGE, 2: StepRole.REST},
            full_cycle_sequence=(StepRole.CHARGE, StepRole.REST),
        ).model_dump(mode="json"),
    }
    configuration.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-validate-test-data", str(source), str(configuration), str(output)],
    )

    with pytest.raises(ValueError, match="absent from test plan"):
        import_cli_main()

    assert output.exists() is False
