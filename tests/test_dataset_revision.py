from __future__ import annotations

from datetime import datetime
from pathlib import Path
from uuid import UUID

import pandas as pd
import pytest

from calb_ess_digital_twin.cell_database import (
    ColumnMapping,
    CycleMetricPolicy,
    DatasetRevisionRequest,
    ImportManifest,
    StepRole,
    ValidationLevel,
    ValidationPolicy,
    verify_dataset_revision_bundle,
    write_dataset_revision_bundle,
)
from calb_ess_digital_twin.cell_database.import_validation import file_sha256
from compute.worker import execute_job_with_artifacts
from contracts.models import DatasetRevisionJobPayload


def _source(path: Path, *, voltage: float = 3.2) -> Path:
    source = path / "cycle.csv"
    pd.DataFrame(
        {
            "time": [f"2026-01-01T0{hour}:00:00+00:00" for hour in range(6)],
            "elapsed": [hour * 3600 for hour in range(6)],
            "voltage": [voltage] * 6,
            "current": [1.0, 1.0, 0.0, -0.75, -0.75, 0.0],
            "cell_temp": [25.0] * 6,
            "ambient_temp": [25.0] * 6,
            "capacity": [0.0, 1.0, 1.5, 0.5, 1.5, 1.5],
            "cycle": [1] * 6,
            "step": [1, 1, 2, 3, 3, 4],
        }
    ).to_csv(source, index=False)
    return source


def _request(source: Path) -> DatasetRevisionRequest:
    mapping_values = (
        ("time", "timestamp", "iso8601"),
        ("elapsed", "elapsed_time_s", "s"),
        ("voltage", "voltage_v", "V"),
        ("current", "current_a", "A"),
        ("cell_temp", "cell_temperature_c", "degC"),
        ("ambient_temp", "ambient_temperature_c", "degC"),
        ("capacity", "capacity_ah", "Ah"),
        ("cycle", "cycle_index", "integer"),
        ("step", "step_index", "integer"),
    )
    return DatasetRevisionRequest(
        revision_id="revision-1",
        dataset_id="dataset-1",
        revision="R1",
        mapping_version="mapping-V1",
        cleaning_rule_version="cleaning-V1",
        code_revision="abcdef1",
        manifest=ImportManifest(
            product_id="product-1",
            sample_id="sample-1",
            batch_code="batch-1",
            test_type="cycle_aging",
            source_lab="lab-1",
            equipment_id="channel-1",
            test_started_at=datetime.fromisoformat("2025-12-31T23:00:00+00:00"),
            test_ended_at=datetime.fromisoformat("2026-01-01T06:00:00+00:00"),
            file_name=source.name,
            file_sha256=file_sha256(source),
            operator="operator-1",
        ),
        mappings=tuple(
            ColumnMapping(source_column=source_name, canonical_column=canonical, source_unit=unit)
            for source_name, canonical, unit in mapping_values
        ),
        validation_policy=ValidationPolicy(
            voltage_min_v=2.0,
            voltage_max_v=3.8,
            absolute_current_max_a=10,
            temperature_min_c=-20,
            temperature_max_c=60,
        ),
        cycle_metric_policy=CycleMetricPolicy(
            nominal_capacity_ah=2.0,
            step_roles={1: StepRole.CHARGE, 2: StepRole.REST, 3: StepRole.DISCHARGE, 4: StepRole.REST},
            full_cycle_sequence=(StepRole.CHARGE, StepRole.REST, StepRole.DISCHARGE, StepRole.REST),
        ),
    )


def test_writes_and_verifies_passed_cycle_revision_bundle(tmp_path: Path) -> None:
    source = _source(tmp_path)
    request = _request(source)
    output = tmp_path / "revision"

    result, manifest = write_dataset_revision_bundle(source, request, output)

    assert result.validation_outcome == ValidationLevel.PASS
    assert result.canonical_available is True
    assert result.cycle_metrics_available is True
    assert result.total_absolute_throughput_ah == pytest.approx(3.0)
    assert manifest.calibration_eligible is True
    assert {path.name for path in output.iterdir()} == {
        "canonical.csv",
        "cycle-metrics.json",
        "dataset-revision-result.json",
        "revision-manifest.json",
        "revision-request.json",
        "validation-report.json",
    }
    assert verify_dataset_revision_bundle(request, output) == (result, manifest)
    with pytest.raises(FileExistsError, match="immutable"):
        write_dataset_revision_bundle(source, request, output)


def test_rejected_revision_retains_report_but_cannot_enter_calibration(tmp_path: Path) -> None:
    source = _source(tmp_path, voltage=4.5)
    request = _request(source)
    output = tmp_path / "rejected"

    result, manifest = write_dataset_revision_bundle(source, request, output)

    assert result.validation_outcome == ValidationLevel.REJECT
    assert result.canonical_available is False
    assert result.cycle_metrics_available is False
    assert manifest.calibration_eligible is False
    assert not (output / "canonical.csv").exists()
    assert not (output / "cycle-metrics.json").exists()


def test_verifier_detects_tampered_revision_artifact(tmp_path: Path) -> None:
    source = _source(tmp_path)
    request = _request(source)
    output = tmp_path / "revision"
    write_dataset_revision_bundle(source, request, output)
    (output / "canonical.csv").write_text("tampered\n", encoding="utf-8")

    with pytest.raises(ValueError, match="integrity"):
        verify_dataset_revision_bundle(request, output)


def test_cycle_revision_requires_explicit_step_policy(tmp_path: Path) -> None:
    source = _source(tmp_path)
    values = _request(source).model_dump()
    values["cycle_metric_policy"] = None
    with pytest.raises(ValueError, match="cycle ageing"):
        DatasetRevisionRequest.model_validate(values)


def test_worker_executes_dataset_revision_as_independent_job(tmp_path: Path) -> None:
    source = _source(tmp_path)
    values = _request(source).model_dump()
    job_id = UUID("1f27154f-3392-48aa-a004-5b18315b0339")
    values["revision_id"] = str(job_id)
    request = DatasetRevisionRequest.model_validate(values)
    payload = DatasetRevisionJobPayload(
        job_id=job_id,
        user_id="alex",
        code_revision=request.code_revision,
        source_file_name=source.name,
        source_checksum_sha256=file_sha256(source),
        dataset_revision_request=request.model_dump(mode="json"),
    )

    outcome = execute_job_with_artifacts(payload, tmp_path / "artifacts", source)

    assert outcome.result.engine == "dataset-revision"
    assert outcome.result.validation_outcome == "pass"
    assert {artifact["kind"] for artifact in outcome.artifacts} == {
        "canonical.csv",
        "cycle-metrics.json",
        "dataset-revision-result.json",
        "revision-manifest.json",
        "revision-request.json",
        "validation-report.json",
    }
