from __future__ import annotations

import hashlib
from datetime import date
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname
from uuid import uuid4

from calb_ess_digital_twin.dispatch import StandardExposurePlan
from calb_ess_digital_twin.soh_engine import (
    CalibrationApprovalStatus,
    CalibrationResult,
    CalibrationValidityEnvelope,
    ExtrapolationLimits,
    SemiEmpiricalParameters,
)
from calb_ess_digital_twin.soh_engine.calibration import FitMetrics
from calb_ess_digital_twin.standard_study import StandardStudyRequest
from compute.store import JobStore
from compute.worker import execute_job_with_artifacts, run_once
from contracts.models import JobPayload


def _request() -> StandardStudyRequest:
    calibration = CalibrationResult(
        calibration_id="calibration-worker-001",
        model_version="semi-empirical-baseline-1",
        code_revision="cal1234",
        product_revision="product-revision-001",
        dataset_revision_ids=("dataset-revision-001",),
        parameters=SemiEmpiricalParameters(
            calendar_coefficient_per_sqrt_day=0.0005,
            throughput_coefficient_per_ah_power=0.000001,
            throughput_exponent=0.8,
        ),
        metrics=FitMetrics(
            training_rmse_fraction=0.001,
            validation_rmse_fraction=0.002,
            validation_max_absolute_error_fraction=0.003,
            jacobian_rank=3,
            jacobian_condition_number=100,
            solver_cost=0.001,
            solver_evaluations=20,
        ),
        validity_envelope=CalibrationValidityEnvelope(
            product_revision="product-revision-001",
            temperature_min_c=15,
            temperature_max_c=35,
            depth_of_discharge_min=0.6,
            depth_of_discharge_max=0.9,
            mean_soc_min=0.4,
            mean_soc_max=0.6,
            charge_c_rate_min=0.2,
            charge_c_rate_max=1.0,
            discharge_c_rate_min=0.2,
            discharge_c_rate_max=1.0,
            training_maximum_elapsed_days=730,
            training_maximum_cycle_count=500,
            training_maximum_equivalent_full_cycles=400,
            training_maximum_absolute_throughput_ah=100000,
            approved_extrapolation_limits=ExtrapolationLimits(
                maximum_elapsed_days=7300,
                maximum_cycle_count=8000,
                maximum_equivalent_full_cycles=7000,
                maximum_absolute_throughput_ah=2_000_000,
            ),
        ),
        fit_converged=True,
        identifiable=True,
        parameters_at_bounds=False,
        meets_validation_limit=True,
        approval_eligible=True,
        warnings=[],
        observation_fits=[],
    )
    plan = StandardExposurePlan(
        standard_scenario_version="scenario-V1",
        code_revision="sce1234",
        product_revision="product-revision-001",
        study_start_date=date(2024, 1, 1),
        horizon_years=2,
        nominal_capacity_ah=314,
        cycles_per_operating_day=0.5,
        operating_availability_fraction=0.9,
        soc_window_min=0.1,
        soc_window_max=0.9,
        depth_of_discharge=0.8,
        cell_temperature_c=25,
        max_charge_c_rate=0.5,
        max_discharge_c_rate=0.5,
    )
    return StandardStudyRequest(
        study_version="study-worker-V1",
        result_version="result-worker-V1",
        exposure_plan=plan,
        calibration=calibration,
        calibration_approval_status=CalibrationApprovalStatus.APPROVED,
    )


def _payload(request: StandardStudyRequest | None = None) -> JobPayload:
    request = request or _request()
    return JobPayload(
        job_id=uuid4(),
        scenario_id=uuid4(),
        user_id="alex",
        engine="standard-study",
        model_version=request.calibration.model_version,
        code_revision="worker123",
        scenario=None,
        standard_study_request=request.model_dump(mode="json"),
    )


def test_worker_creates_and_registers_complete_immutable_study_bundle(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    payload = _payload()
    assert store.enqueue(str(payload.job_id), payload.model_dump(mode="json"))

    assert run_once(store, "worker-a", artifact_root=tmp_path / "artifact-store")

    row = store.get(str(payload.job_id))
    assert row is not None
    assert row["status"] == "completed"
    registrations = store.artifacts(str(payload.job_id))
    assert {item["kind"] for item in registrations} == {
        "manifest.json",
        "scenario-exposure.json",
        "soh-result.json",
        "study-request.json",
    }
    for item in registrations:
        path = Path(url2pathname(urlparse(item["uri"]).path))
        content = path.read_bytes()
        assert item["size_bytes"] == len(content)
        assert item["checksum_sha256"] == hashlib.sha256(content).hexdigest()


def test_reexecution_reuses_only_a_checksum_verified_matching_bundle(tmp_path: Path) -> None:
    payload = _payload()
    artifact_root = tmp_path / "artifact-store"

    first = execute_job_with_artifacts(payload, artifact_root)
    second = execute_job_with_artifacts(payload, artifact_root)

    assert first.result.artifact_checksums == second.result.artifact_checksums
    assert first.artifacts == second.artifacts
    assert second.result.within_validity_envelope is True
    assert second.result.end_soh is not None


def test_job_model_version_must_name_the_embedded_calibration(tmp_path: Path) -> None:
    payload = _payload().model_copy(update={"model_version": "different-model"})
    store = JobStore(tmp_path / "jobs.sqlite3")
    assert store.enqueue(str(payload.job_id), payload.model_dump(mode="json"))

    assert run_once(store, "worker-a", artifact_root=tmp_path / "artifact-store")

    row = store.get(str(payload.job_id))
    assert row is not None
    assert row["status"] == "failed"
    assert "model_version does not match" in row["error"]
    assert store.artifacts(str(payload.job_id)) == []
