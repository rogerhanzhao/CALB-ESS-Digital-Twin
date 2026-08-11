from __future__ import annotations

import hashlib
import sys
from datetime import date
from pathlib import Path

import pytest
import yaml

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
from calb_ess_digital_twin.standard_study_cli import main as standard_study_cli_main


def _calibration() -> CalibrationResult:
    return CalibrationResult(
        calibration_id="calibration-001",
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


def _plan(**updates: object) -> StandardExposurePlan:
    values: dict[str, object] = {
        "standard_scenario_version": "scenario-V1",
        "code_revision": "sce1234",
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


def _request(**updates: object) -> StandardStudyRequest:
    values: dict[str, object] = {
        "study_version": "study-V1",
        "result_version": "result-V1",
        "exposure_plan": _plan(),
        "calibration": _calibration(),
        "calibration_approval_status": CalibrationApprovalStatus.APPROVED,
    }
    values.update(updates)
    return StandardStudyRequest.model_validate(values)


def test_writes_complete_checksum_verified_non_overwriting_bundle(tmp_path: Path) -> None:
    output = tmp_path / "study-V1"

    artifact, manifest = write_standard_study_bundle(_request(), output)

    assert artifact.soh_result.engineering_review_eligible is True
    assert artifact.soh_result.warranty_eligible is False
    assert {path.name for path in output.iterdir()} == {
        "study-request.json",
        "scenario-exposure.json",
        "soh-result.json",
        "manifest.json",
    }
    for record in manifest.files:
        content = (output / record.file_name).read_bytes()
        assert record.byte_count == len(content)
        assert record.sha256 == hashlib.sha256(content).hexdigest()
    with pytest.raises(FileExistsError, match="immutable"):
        write_standard_study_bundle(_request(), output)


def test_new_result_version_creates_distinct_request_evidence(tmp_path: Path) -> None:
    first_output = tmp_path / "study-V1"
    second_output = tmp_path / "study-V2"
    first_request = _request()
    second_request = _request(study_version="study-V2", result_version="result-V2")

    _, first_manifest = write_standard_study_bundle(first_request, first_output)
    _, second_manifest = write_standard_study_bundle(second_request, second_output)

    first_sha = next(
        item.sha256 for item in first_manifest.files if item.file_name == "study-request.json"
    )
    second_sha = next(
        item.sha256 for item in second_manifest.files if item.file_name == "study-request.json"
    )
    assert first_sha != second_sha
    assert first_output.is_dir()
    assert second_output.is_dir()


def test_product_mismatch_fails_before_creating_bundle(tmp_path: Path) -> None:
    output = tmp_path / "invalid-study"
    request = _request(exposure_plan=_plan(product_revision="different-product"))

    with pytest.raises(ValueError, match="product_revision does not match"):
        write_standard_study_bundle(request, output)

    assert output.exists() is False


def test_manifest_keeps_scenario_and_calibration_revisions_separate(tmp_path: Path) -> None:
    _, manifest = write_standard_study_bundle(_request(), tmp_path / "study-V1")

    assert manifest.scenario_code_revision == "sce1234"
    assert manifest.calibration_code_revision == "cal1234"
    assert manifest.standard_scenario_version == "scenario-V1"
    assert manifest.calibration_id == "calibration-001"


def test_cli_creates_exploratory_bundle_and_returns_diagnostic_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_path = tmp_path / "study.yaml"
    output = tmp_path / "study-under-review"
    request = _request(
        calibration_approval_status=CalibrationApprovalStatus.UNDER_REVIEW
    )
    request_path.write_text(
        yaml.safe_dump(request.model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-run-standard-study", str(request_path), str(output)],
    )

    exit_code = standard_study_cli_main()

    assert exit_code == 2
    assert (output / "manifest.json").is_file()
    assert (output / "soh-result.json").is_file()
