from __future__ import annotations

import hashlib
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname
from uuid import uuid4

import pytest
import yaml
from pydantic import ValidationError

from calb_ess_digital_twin.dispatch import StandardExposurePlan
from calb_ess_digital_twin.soh_engine import (
    CalibrationApprovalStatus,
    CalibrationResult,
    CalibrationValidityEnvelope,
    ExtrapolationLimits,
    SemiEmpiricalParameters,
)
from calb_ess_digital_twin.soh_engine.calibration import FitMetrics
from calb_ess_digital_twin.standard_study import (
    StandardStudyRequest,
    write_standard_study_bundle,
)
from calb_ess_digital_twin.study_comparison import (
    CapacityDirection,
    StudyComparisonPolicy,
    StudyComparisonRequest,
    StudyVersionEvidence,
    TrustTransition,
    compare_standard_studies,
    load_study_comparison_bundle,
    write_study_comparison_bundle,
)
from calb_ess_digital_twin.study_comparison_cli import (
    load_bundle,
)
from calb_ess_digital_twin.study_comparison_cli import (
    main as comparison_cli_main,
)
from compute.store import JobStore
from compute.worker import execute_job_with_artifacts, run_once
from contracts.models import ComparisonJobPayload


def _calibration(
    label: str,
    *,
    calendar_coefficient: float = 0.0005,
    maximum_throughput_ah: float = 2_000_000,
) -> CalibrationResult:
    return CalibrationResult(
        calibration_id=f"calibration-{label}",
        model_version=f"semi-empirical-{label}",
        code_revision=f"cal{label}123",
        product_revision="product-revision-001",
        dataset_revision_ids=(f"dataset-revision-{label}",),
        parameters=SemiEmpiricalParameters(
            calendar_coefficient_per_sqrt_day=calendar_coefficient,
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
                maximum_absolute_throughput_ah=maximum_throughput_ah,
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


def _plan(**updates: object) -> StandardExposurePlan:
    values: dict[str, object] = {
        "standard_scenario_version": "scenario-V1",
        "code_revision": "scenario123",
        "product_revision": "product-revision-001",
        "study_start_date": date(2024, 1, 1),
        "horizon_years": 2,
        "nominal_capacity_ah": 314,
        "cycles_per_operating_day": 0.5,
        "operating_availability_fraction": 0.9,
        "soc_window_min": 0.1,
        "soc_window_max": 0.9,
        "depth_of_discharge": 0.8,
        "cell_temperature_c": 25,
        "max_charge_c_rate": 0.5,
        "max_discharge_c_rate": 0.5,
    }
    values.update(updates)
    return StandardExposurePlan.model_validate(values)


def _evidence(
    tmp_path: Path,
    label: str,
    *,
    calibration: CalibrationResult | None = None,
    plan: StandardExposurePlan | None = None,
) -> StudyVersionEvidence:
    request = StandardStudyRequest(
        study_version=f"study-{label}",
        result_version=f"result-{label}",
        exposure_plan=plan or _plan(),
        calibration=calibration or _calibration(label),
        calibration_approval_status=CalibrationApprovalStatus.APPROVED,
    )
    artifact, manifest = write_standard_study_bundle(request, tmp_path / f"study-{label}")
    return StudyVersionEvidence(request=request, artifact=artifact, manifest=manifest)


def _comparison_request(
    baseline: StudyVersionEvidence,
    current: StudyVersionEvidence,
    *,
    capacity_tolerance: float = 1e-9,
    exposure_tolerance: float = 1e-9,
) -> StudyComparisonRequest:
    return StudyComparisonRequest(
        comparison_version="comparison-V1",
        baseline=baseline,
        current=current,
        policy=StudyComparisonPolicy(
            capacity_delta_tolerance_fraction=capacity_tolerance,
            elapsed_days_tolerance=exposure_tolerance,
            absolute_throughput_ah_tolerance=exposure_tolerance,
            cycle_count_tolerance=exposure_tolerance,
            equivalent_full_cycles_tolerance=exposure_tolerance,
        ),
    )


def test_new_calibration_is_compared_at_every_identical_annual_point(tmp_path: Path) -> None:
    baseline = _evidence(tmp_path, "V1")
    current = _evidence(
        tmp_path,
        "V2",
        calibration=_calibration("V2", calendar_coefficient=0.0004),
    )

    result = compare_standard_studies(_comparison_request(baseline, current))

    assert result.comparison_is_like_for_like is True
    assert result.calibration_evidence_changed is True
    assert result.current_dataset_revision_ids == ("dataset-revision-V2",)
    assert result.final_capacity_delta_fraction > 0
    assert result.improved_point_count == 2
    assert result.unchanged_point_count == 1
    assert result.degraded_point_count == 0
    assert result.points[-1].capacity_direction == CapacityDirection.IMPROVED


def test_method_supplied_capacity_tolerance_controls_unchanged_classification(
    tmp_path: Path,
) -> None:
    baseline = _evidence(tmp_path, "V1")
    current = _evidence(
        tmp_path,
        "V2",
        calibration=_calibration("V2", calendar_coefficient=0.0004999),
    )

    result = compare_standard_studies(
        _comparison_request(baseline, current, capacity_tolerance=0.001)
    )

    assert result.unchanged_point_count == len(result.points)


def test_changed_exposure_is_rejected_as_confounded_model_comparison(tmp_path: Path) -> None:
    baseline = _evidence(tmp_path, "V1")
    current = _evidence(
        tmp_path,
        "V2",
        plan=_plan(cycles_per_operating_day=0.6),
    )

    with pytest.raises(ValidationError, match="trajectory absolute_throughput_ah differs"):
        _comparison_request(baseline, current)


def test_changed_standard_scenario_version_is_not_like_for_like(tmp_path: Path) -> None:
    baseline = _evidence(tmp_path, "V1")
    current = _evidence(
        tmp_path,
        "V2",
        plan=_plan(standard_scenario_version="scenario-V2"),
    )

    with pytest.raises(ValidationError, match="standard scenario version differs"):
        _comparison_request(baseline, current)


def test_manifest_and_artifact_must_match_before_comparison(tmp_path: Path) -> None:
    baseline = _evidence(tmp_path, "V1")
    bad_manifest = baseline.manifest.model_copy(update={"result_version": "wrong"})

    with pytest.raises(ValidationError, match="manifest result_version does not match"):
        StudyVersionEvidence(
            request=baseline.request,
            artifact=baseline.artifact,
            manifest=bad_manifest,
        )


def test_modified_bundle_file_is_rejected_before_comparison(tmp_path: Path) -> None:
    _evidence(tmp_path, "V1")
    result_path = tmp_path / "study-V1" / "soh-result.json"
    result_path.write_text(result_path.read_text(encoding="utf-8") + " ", encoding="utf-8")

    with pytest.raises(ValueError, match="byte count mismatch"):
        load_bundle(tmp_path / "study-V1")


def test_validity_transition_identifies_first_newly_outside_year(tmp_path: Path) -> None:
    baseline = _evidence(tmp_path, "V1")
    current = _evidence(
        tmp_path,
        "V2",
        calibration=_calibration("V2", maximum_throughput_ah=100000),
    )

    result = compare_standard_studies(_comparison_request(baseline, current))

    assert result.validity_changed_years == (2,)
    assert result.points[-1].validity_transition == TrustTransition.BECAME_INVALID
    assert result.engineering_review_eligibility_changed is True


def test_same_exposure_with_new_scenario_code_revision_is_visible(tmp_path: Path) -> None:
    baseline = _evidence(tmp_path, "V1")
    current = _evidence(
        tmp_path,
        "V2",
        plan=_plan(code_revision="scenario456"),
    )

    result = compare_standard_studies(_comparison_request(baseline, current))

    assert result.scenario_code_revision_changed is True
    assert result.comparison_is_like_for_like is True


def test_cli_writes_non_overwriting_comparison_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _evidence(tmp_path, "V1")
    _evidence(
        tmp_path,
        "V2",
        calibration=_calibration("V2", calendar_coefficient=0.0004),
    )
    configuration_path = tmp_path / "comparison.yaml"
    result_path = tmp_path / "comparison-V1.json"
    configuration_path.write_text(
        yaml.safe_dump(
            {
                "schema_version": "V0.2",
                "comparison_version": "comparison-V1",
                "policy": {
                    "capacity_delta_tolerance_fraction": 1e-9,
                    "elapsed_days_tolerance": 1e-9,
                    "absolute_throughput_ah_tolerance": 1e-9,
                    "cycle_count_tolerance": 1e-9,
                    "equivalent_full_cycles_tolerance": 1e-9,
                },
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "calb-compare-standard-studies",
            str(tmp_path / "study-V1"),
            str(tmp_path / "study-V2"),
            str(configuration_path),
            str(result_path),
        ],
    )

    exit_code = comparison_cli_main()

    assert exit_code == 0
    assert '"comparison_is_like_for_like": true' in result_path.read_text(encoding="utf-8")


def test_comparison_bundle_is_immutable_and_checksum_verified(tmp_path: Path) -> None:
    request = _comparison_request(_evidence(tmp_path, "V1"), _evidence(tmp_path, "V2"))
    directory = tmp_path / "comparison-bundle"

    result, manifest = write_study_comparison_bundle(request, directory)
    loaded_request, loaded_result, loaded_manifest = load_study_comparison_bundle(directory)

    assert loaded_request == request
    assert loaded_result == result
    assert loaded_manifest == manifest
    assert {item.file_name for item in manifest.files} == {
        "comparison-request.json",
        "comparison-result.json",
    }
    with pytest.raises(FileExistsError, match="immutable"):
        write_study_comparison_bundle(request, directory)


def test_worker_executes_comparison_as_independent_job(tmp_path: Path) -> None:
    request = _comparison_request(
        _evidence(tmp_path, "V1"),
        _evidence(
            tmp_path,
            "V2",
            calibration=_calibration("V2", calendar_coefficient=0.0004),
        ),
    )
    payload = ComparisonJobPayload(
        job_id=uuid4(),
        user_id="alex",
        code_revision="compare123",
        study_comparison_request=request.model_dump(mode="json"),
    )
    store = JobStore(tmp_path / "comparison-jobs.sqlite3")
    assert store.enqueue(str(payload.job_id), payload.model_dump(mode="json"))

    assert run_once(store, "comparison-worker", artifact_root=tmp_path / "artifacts")

    row = store.get(str(payload.job_id))
    assert row is not None
    assert row["status"] == "completed"
    registrations = store.artifacts(str(payload.job_id))
    assert {item["kind"] for item in registrations} == {
        "comparison-manifest.json",
        "comparison-request.json",
        "comparison-result.json",
    }
    for item in registrations:
        path = Path(url2pathname(urlparse(item["uri"]).path))
        assert item["checksum_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()

    repeated = execute_job_with_artifacts(payload, tmp_path / "artifacts")
    assert repeated.result.artifact_checksums == {
        item["kind"]: item["checksum_sha256"] for item in registrations
    }
