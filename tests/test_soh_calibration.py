from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import yaml
from pydantic import ValidationError

from calb_ess_digital_twin.soh_engine import (
    AgingObservation,
    CalibrationRequest,
    SemiEmpiricalParameters,
    SplitRole,
    capacity_fraction,
    fit_semi_empirical_model,
)
from calb_ess_digital_twin.soh_engine.calibration_cli import main as calibration_cli_main

TRUE_A = 0.001
TRUE_B = 0.0001
TRUE_C = 0.7


def _observation(
    name: str,
    split: SplitRole,
    elapsed_days: float,
    throughput_ah: float,
    *,
    sample_id: str | None = None,
    capacity_override: float | None = None,
    temperature_c: float = 25.0,
) -> AgingObservation:
    loss = TRUE_A * np.sqrt(elapsed_days) + TRUE_B * throughput_ah**TRUE_C
    return AgingObservation(
        observation_id=f"observation-{name}",
        dataset_revision_id=f"dataset-revision-{name}",
        product_revision="product-revision-001",
        sample_id=sample_id or f"sample-{name}",
        split=split,
        elapsed_days=elapsed_days,
        absolute_throughput_ah=throughput_ah,
        measured_capacity_fraction=capacity_override or 1.0 - loss,
        cell_temperature_c=temperature_c,
        depth_of_discharge=0.8,
        mean_soc=0.5,
        max_charge_c_rate=0.5,
        max_discharge_c_rate=0.5,
        cycle_count=int(throughput_ah / 2),
        equivalent_full_cycles=throughput_ah / 4,
    )


def _request(
    observations: list[AgingObservation] | None = None,
    validation_limit: float = 1e-6,
) -> CalibrationRequest:
    if observations is None:
        observations = [
            _observation("train-1", SplitRole.TRAIN, 25, 100, temperature_c=15),
            _observation("train-2", SplitRole.TRAIN, 100, 180, temperature_c=20),
            _observation("train-3", SplitRole.TRAIN, 225, 350, temperature_c=25),
            _observation("train-4", SplitRole.TRAIN, 400, 500, temperature_c=30),
            _observation("train-5", SplitRole.TRAIN, 625, 800, temperature_c=35),
            _observation("validation-1", SplitRole.VALIDATION, 144, 250, temperature_c=10),
            _observation("validation-2", SplitRole.VALIDATION, 900, 1000, temperature_c=40),
        ]
    return CalibrationRequest(
        calibration_id="calibration-001",
        model_version="semi-empirical-baseline-1",
        code_revision="1234567",
        observations=observations,
        exponent_min=0.3,
        exponent_max=1.5,
        validation_rmse_limit_fraction=validation_limit,
        minimum_training_sample_count=3,
        minimum_validation_sample_count=2,
    )


def test_recovers_known_parameters_and_scores_held_out_samples() -> None:
    result = fit_semi_empirical_model(_request())

    assert result.fit_converged is True
    assert result.identifiable is True
    assert result.meets_validation_limit is True
    assert result.parameters_at_bounds is False
    assert result.approval_eligible is True
    assert result.parameters.calendar_coefficient_per_sqrt_day == pytest.approx(
        TRUE_A, rel=1e-4
    )
    assert result.parameters.throughput_coefficient_per_ah_power == pytest.approx(
        TRUE_B, rel=1e-4
    )
    assert result.parameters.throughput_exponent == pytest.approx(TRUE_C, rel=1e-4)
    assert result.metrics.validation_rmse_fraction < 1e-8
    assert result.metrics.jacobian_rank == 3
    assert len(result.observation_fits) == 7


def test_validation_points_do_not_expand_training_validity_envelope() -> None:
    result = fit_semi_empirical_model(_request())

    envelope = result.validity_envelope
    assert envelope.temperature_min_c == 15
    assert envelope.temperature_max_c == 35
    assert envelope.maximum_elapsed_days == 625
    assert envelope.maximum_absolute_throughput_ah == 800


def test_sample_identity_cannot_leak_across_train_and_validation() -> None:
    observations = [
        _observation("train-1", SplitRole.TRAIN, 25, 100, sample_id="shared"),
        _observation("train-2", SplitRole.TRAIN, 100, 180),
        _observation("train-3", SplitRole.TRAIN, 225, 350),
        _observation("train-4", SplitRole.TRAIN, 300, 420),
        _observation("validation", SplitRole.VALIDATION, 400, 500, sample_id="shared"),
        _observation("validation-2", SplitRole.VALIDATION, 500, 650),
    ]

    with pytest.raises(ValidationError, match="sample leakage"):
        _request(observations)


def test_method_declares_minimum_independent_sample_counts() -> None:
    request = _request()
    request_data = request.model_dump(mode="python")
    request_data["minimum_validation_sample_count"] = 3

    with pytest.raises(ValidationError, match="minimum_validation_sample_count"):
        CalibrationRequest.model_validate(request_data)


def test_held_out_rmse_limit_is_method_input_not_hard_coded() -> None:
    request = _request()
    changed = request.model_copy(deep=True)
    validation = next(
        item for item in changed.observations if item.split == SplitRole.VALIDATION
    )
    validation.measured_capacity_fraction = 0.9
    changed.validation_rmse_limit_fraction = 0.001

    result = fit_semi_empirical_model(changed)

    assert result.fit_converged is True
    assert result.meets_validation_limit is False
    assert result.approval_eligible is False
    assert "held-out validation RMSE" in result.warnings[-1]


def test_rank_deficient_exposure_is_reported_not_silently_approved() -> None:
    observations = [
        _observation("train-1", SplitRole.TRAIN, 25, 0),
        _observation("train-2", SplitRole.TRAIN, 100, 0),
        _observation("train-3", SplitRole.TRAIN, 225, 0),
        _observation("train-4", SplitRole.TRAIN, 300, 0),
        _observation("validation", SplitRole.VALIDATION, 400, 0),
        _observation("validation-2", SplitRole.VALIDATION, 500, 0),
    ]

    result = fit_semi_empirical_model(_request(observations))

    assert result.identifiable is False
    assert result.approval_eligible is False
    assert result.metrics.jacobian_rank < 3
    assert result.metrics.jacobian_condition_number is None
    assert any("rank-deficient" in warning for warning in result.warnings)


def test_exponent_at_configured_boundary_requires_review() -> None:
    request = _request()
    request.exponent_min = TRUE_C

    result = fit_semi_empirical_model(request)

    assert result.parameters.throughput_exponent == pytest.approx(TRUE_C, abs=1e-6)
    assert result.parameters_at_bounds is True
    assert result.approval_eligible is False
    assert any("constraint boundary" in warning for warning in result.warnings)


def test_constrained_baseline_is_monotone_with_both_exposures() -> None:
    parameters = SemiEmpiricalParameters(
        calendar_coefficient_per_sqrt_day=TRUE_A,
        throughput_coefficient_per_ah_power=TRUE_B,
        throughput_exponent=TRUE_C,
    )

    by_time = capacity_fraction(np.array([0, 10, 100, 1000]), 0, parameters)
    by_throughput = capacity_fraction(0, np.array([0, 100, 1000, 10000]), parameters)

    assert np.all(np.diff(by_time) <= 0)
    assert np.all(np.diff(by_throughput) <= 0)
    assert by_time[0] == 1.0
    assert by_throughput[0] == 1.0


def test_negative_prediction_exposure_is_rejected() -> None:
    parameters = SemiEmpiricalParameters(
        calendar_coefficient_per_sqrt_day=TRUE_A,
        throughput_coefficient_per_ah_power=TRUE_B,
        throughput_exponent=TRUE_C,
    )

    with pytest.raises(ValueError, match="cannot be negative"):
        capacity_fraction(-1, 0, parameters)


def test_cli_writes_non_overwriting_draft_calibration_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_path = tmp_path / "calibration-request.yaml"
    result_path = tmp_path / "calibration-result.json"
    request_path.write_text(
        yaml.safe_dump(_request().model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["calb-fit-soh-baseline", str(request_path), str(result_path)],
    )

    exit_code = calibration_cli_main()

    assert exit_code == 0
    assert result_path.is_file()
    assert '"approval_eligible": true' in result_path.read_text(encoding="utf-8")
