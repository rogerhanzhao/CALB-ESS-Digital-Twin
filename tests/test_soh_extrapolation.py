from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import yaml
from pydantic import ValidationError

from calb_ess_digital_twin.soh_engine import (
    CalibrationApprovalStatus,
    CalibrationResult,
    CalibrationValidityEnvelope,
    ExposurePoint,
    ExtrapolationLimits,
    ExtrapolationRequest,
    SemiEmpiricalParameters,
    StandardScenarioConditions,
    TrajectoryIssue,
    extrapolate_soh,
)
from calb_ess_digital_twin.soh_engine.calibration import FitMetrics
from calb_ess_digital_twin.soh_engine.extrapolation_cli import main as extrapolation_cli_main


def _calibration() -> CalibrationResult:
    return CalibrationResult(
        calibration_id="calibration-001",
        model_version="semi-empirical-baseline-1",
        code_revision="1234567",
        product_revision="product-revision-001",
        dataset_revision_ids=("dataset-revision-001",),
        parameters=SemiEmpiricalParameters(
            calendar_coefficient_per_sqrt_day=0.0005,
            throughput_coefficient_per_ah_power=0.00001,
            throughput_exponent=0.8,
        ),
        metrics=FitMetrics(
            training_rmse_fraction=0.001,
            validation_rmse_fraction=0.002,
            validation_max_absolute_error_fraction=0.003,
            jacobian_rank=3,
            jacobian_condition_number=100.0,
            solver_cost=0.0001,
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
            training_maximum_cycle_count=700,
            training_maximum_equivalent_full_cycles=500,
            training_maximum_absolute_throughput_ah=2000,
            approved_extrapolation_limits=ExtrapolationLimits(
                maximum_elapsed_days=7300,
                maximum_cycle_count=7300,
                maximum_equivalent_full_cycles=6500,
                maximum_absolute_throughput_ah=26000,
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


def _conditions(**updates: float | str) -> StandardScenarioConditions:
    values: dict[str, float | str] = {
        "product_revision": "product-revision-001",
        "cell_temperature_c": 25.0,
        "depth_of_discharge": 0.8,
        "mean_soc": 0.5,
        "max_charge_c_rate": 0.5,
        "max_discharge_c_rate": 0.5,
    }
    values.update(updates)
    return StandardScenarioConditions.model_validate(values)


def _points() -> list[ExposurePoint]:
    return [
        ExposurePoint(
            year=0,
            elapsed_days=0,
            absolute_throughput_ah=0,
            cycle_count=0,
            equivalent_full_cycles=0,
        ),
        ExposurePoint(
            year=1,
            elapsed_days=365,
            absolute_throughput_ah=1000,
            cycle_count=365,
            equivalent_full_cycles=250,
        ),
        ExposurePoint(
            year=20,
            elapsed_days=7300,
            absolute_throughput_ah=20000,
            cycle_count=7000,
            equivalent_full_cycles=5000,
        ),
    ]


def _request(
    *,
    calibration: CalibrationResult | None = None,
    status: CalibrationApprovalStatus = CalibrationApprovalStatus.APPROVED,
    conditions: StandardScenarioConditions | None = None,
    points: list[ExposurePoint] | None = None,
) -> ExtrapolationRequest:
    return ExtrapolationRequest(
        result_version="result-V1",
        standard_scenario_version="scenario-V1",
        calibration=calibration or _calibration(),
        calibration_approval_status=status,
        conditions=conditions or _conditions(),
        exposure_points=points or _points(),
    )


def test_approved_in_envelope_trajectory_is_monotone_but_not_warranty_ready() -> None:
    result = extrapolate_soh(_request())

    capacity = np.array([point.predicted_capacity_fraction for point in result.points])
    assert np.all(np.diff(capacity) <= 0)
    assert result.all_points_within_validity_envelope is True
    assert result.all_predictions_physically_valid is True
    assert result.engineering_review_eligible is True
    assert result.uncertainty_status == "not_quantified"
    assert result.warranty_eligible is False
    assert "cannot directly support warranty" in result.warnings[0]


def test_condition_outside_envelope_marks_every_point_with_reason() -> None:
    result = extrapolate_soh(_request(conditions=_conditions(cell_temperature_c=40.0)))

    assert result.all_points_within_validity_envelope is False
    assert result.engineering_review_eligible is False
    assert all(
        TrajectoryIssue.TEMPERATURE in point.issues for point in result.points
    )


def test_exposure_violation_starts_at_the_point_that_crosses_boundary() -> None:
    points = _points()
    points[-1] = points[-1].model_copy(update={"absolute_throughput_ah": 27000})

    result = extrapolate_soh(_request(points=points))

    assert result.points[0].within_validity_envelope is True
    assert result.points[1].within_validity_envelope is True
    assert result.points[2].within_validity_envelope is False
    assert TrajectoryIssue.ABSOLUTE_THROUGHPUT in result.points[2].issues


def test_unapproved_calibration_keeps_in_envelope_run_exploratory() -> None:
    result = extrapolate_soh(_request(status=CalibrationApprovalStatus.UNDER_REVIEW))

    assert result.all_points_within_validity_envelope is True
    assert result.engineering_review_eligible is False
    assert any("trajectory is exploratory" in warning for warning in result.warnings)


def test_computationally_ineligible_calibration_cannot_be_marked_approved() -> None:
    calibration_data = _calibration().model_dump()
    calibration_data.update({"fit_converged": False, "approval_eligible": False})
    calibration = CalibrationResult.model_validate(calibration_data)

    with pytest.raises(ValidationError, match="cannot be marked approved"):
        _request(calibration=calibration)


def test_exposure_trajectory_cannot_move_backward() -> None:
    points = _points()
    points[-1] = points[-1].model_copy(update={"cycle_count": 100})

    with pytest.raises(ValidationError, match="cycle_count must not decrease"):
        _request(points=points)


def test_planned_cycle_count_can_be_fractional_without_rounding() -> None:
    points = _points()
    points[1] = points[1].model_copy(update={"cycle_count": 182.5})

    result = extrapolate_soh(_request(points=points))

    assert result.points[1].cycle_count == 182.5


def test_non_physical_prediction_is_reported_without_clipping() -> None:
    calibration = _calibration()
    calibration.parameters = SemiEmpiricalParameters(
        calendar_coefficient_per_sqrt_day=0.1,
        throughput_coefficient_per_ah_power=0.01,
        throughput_exponent=1.0,
    )

    result = extrapolate_soh(_request(calibration=calibration))

    final = result.points[-1]
    assert final.predicted_capacity_fraction < 0
    assert TrajectoryIssue.NON_PHYSICAL_CAPACITY in final.issues
    assert final.within_validity_envelope is True
    assert final.physically_valid_prediction is False
    assert result.all_predictions_physically_valid is False
    assert result.engineering_review_eligible is False


def test_scenario_product_must_match_calibration_product() -> None:
    with pytest.raises(ValidationError, match="product_revision does not match"):
        _request(conditions=_conditions(product_revision="different-product"))


def test_validity_envelope_product_must_match_calibration_product() -> None:
    calibration = _calibration()
    envelope = calibration.validity_envelope.model_copy(
        update={"product_revision": "different-product"}
    )
    calibration = calibration.model_copy(update={"validity_envelope": envelope})

    with pytest.raises(ValidationError, match="validity-envelope product_revision"):
        _request(calibration=calibration)


def test_cli_writes_versioned_non_overwriting_trajectory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_path = tmp_path / "extrapolation-request.yaml"
    result_path = tmp_path / "soh-result.json"
    request_path.write_text(
        yaml.safe_dump(_request().model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-extrapolate-soh", str(request_path), str(result_path)],
    )

    exit_code = extrapolation_cli_main()

    assert exit_code == 0
    result_text = result_path.read_text(encoding="utf-8")
    assert '"result_version": "result-V1"' in result_text
    assert '"warranty_eligible": false' in result_text


def test_cli_refuses_to_overwrite_existing_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_path = tmp_path / "extrapolation-request.yaml"
    result_path = tmp_path / "soh-result.json"
    request_path.write_text(
        yaml.safe_dump(_request().model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    result_path.write_text("original", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-extrapolate-soh", str(request_path), str(result_path)],
    )

    with pytest.raises(SystemExit):
        extrapolation_cli_main()

    assert result_path.read_text(encoding="utf-8") == "original"
