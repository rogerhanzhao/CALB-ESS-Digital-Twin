import json
from pathlib import Path
from uuid import UUID

import numpy as np
import pytest

from calb_ess_digital_twin.soh_engine import (
    AgingObservation,
    CalibrationRequest,
    ExtrapolationLimits,
    SplitRole,
    verify_calibration_bundle,
    write_calibration_bundle,
)
from compute.worker import execute_job_with_artifacts
from contracts.models import CalibrationFitJobPayload


def _observation(index: int, split: SplitRole, sample: str) -> AgingObservation:
    days = float((index + 1) ** 2 * 25)
    throughput = float((index + 1) * 120)
    loss = 0.0005 * np.sqrt(days) + 0.00002 * throughput**0.8
    return AgingObservation(
        observation_id=f"observation-{index}",
        dataset_revision_id=f"revision-{sample}",
        product_revision="R1",
        sample_id=sample,
        split=split,
        elapsed_days=days,
        absolute_throughput_ah=throughput,
        measured_capacity_fraction=1 - loss,
        cell_temperature_c=25,
        depth_of_discharge=0.8,
        mean_soc=0.5,
        max_charge_c_rate=0.5,
        max_discharge_c_rate=0.5,
        cycle_count=index * 100,
        equivalent_full_cycles=index * 80,
    )


def _request(calibration_id: str = "00000000-0000-4000-8000-000000000041") -> CalibrationRequest:
    observations = [
        _observation(0, SplitRole.TRAIN, "train-a"),
        _observation(1, SplitRole.TRAIN, "train-b"),
        _observation(2, SplitRole.TRAIN, "train-c"),
        _observation(3, SplitRole.TRAIN, "train-d"),
        _observation(4, SplitRole.VALIDATION, "validation-a"),
    ]
    return CalibrationRequest(
        calibration_id=calibration_id,
        model_version="semi-empirical-V1",
        code_revision="abcdef1",
        observations=observations,
        exponent_min=0.3,
        exponent_max=1.5,
        validation_rmse_limit_fraction=0.01,
        minimum_training_sample_count=4,
        minimum_validation_sample_count=1,
        approved_extrapolation_limits=ExtrapolationLimits(
            maximum_elapsed_days=7300,
            maximum_cycle_count=7300,
            maximum_equivalent_full_cycles=6500,
            maximum_absolute_throughput_ah=100000,
        ),
    )


def test_calibration_bundle_is_immutable_and_verifiable(tmp_path: Path):
    request = _request()
    directory = tmp_path / "bundle"
    result, manifest = write_calibration_bundle(request, directory)
    assert result.calibration_id == request.calibration_id
    assert {item.file_name for item in manifest.files} == {
        "calibration-request.json", "calibration-result.json",
    }
    assert verify_calibration_bundle(request, directory)[0] == result
    with pytest.raises(FileExistsError, match="immutable"):
        write_calibration_bundle(request, directory)


def test_calibration_bundle_rejects_tampered_result(tmp_path: Path):
    request = _request()
    directory = tmp_path / "bundle"
    write_calibration_bundle(request, directory)
    result_path = directory / "calibration-result.json"
    result_path.write_text(result_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
    with pytest.raises(ValueError, match="integrity"):
        verify_calibration_bundle(request, directory)


def test_worker_executes_and_reuses_calibration_fit_bundle(tmp_path: Path):
    request = _request()
    payload = CalibrationFitJobPayload(
        job_id=UUID(request.calibration_id),
        user_id="alex",
        code_revision=request.code_revision,
        calibration_request=request.model_dump(mode="json"),
    )
    first = execute_job_with_artifacts(payload, tmp_path)
    second = execute_job_with_artifacts(payload, tmp_path)
    assert first.result.artifact_checksums == second.result.artifact_checksums
    assert first.result.calibration_id == second.result.calibration_id
    assert len(first.artifacts) == 3
    assert first.result.artifact_checksums == {
        item["kind"]: item["checksum_sha256"] for item in first.artifacts
    }
    stored = json.loads(
        (tmp_path / request.calibration_id / "calibration-fit" / "calibration-result.json").read_text()
    )
    assert stored["calibration_id"] == request.calibration_id


def test_worker_rejects_job_and_request_identity_mismatch(tmp_path: Path):
    request = _request("calibration-other")
    payload = CalibrationFitJobPayload(
        job_id=UUID("00000000-0000-4000-8000-000000000041"),
        user_id="alex",
        code_revision=request.code_revision,
        calibration_request=request.model_dump(mode="json"),
    )
    with pytest.raises(ValueError, match="identity"):
        execute_job_with_artifacts(payload, tmp_path)
