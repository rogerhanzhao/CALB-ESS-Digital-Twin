from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from contracts.export_schema import export
from contracts.models import JobPayload, ScenarioInput


def valid_job() -> JobPayload:
    return JobPayload(
        job_id=uuid4(),
        scenario_id=uuid4(),
        user_id="alex",
        engine="stub",
        model_version="stub-1",
        code_revision="1234567",
        scenario=ScenarioInput(
            name="LFP baseline",
            cell_param_set_version="calb-lfp-placeholder-1",
            horizon_years=20,
            cycles_per_day=1.0,
            depth_of_discharge=0.9,
            soc_window_min=0.05,
            soc_window_max=0.95,
            ambient_temperature_c=25.0,
            initial_soc=0.5,
            end_of_life_fraction=0.8,
        ),
    )


def test_contract_rejects_explicit_null() -> None:
    data = valid_job().model_dump(mode="json")
    data["scenario"]["horizon_years"] = None
    with pytest.raises(ValidationError):
        JobPayload.model_validate(data)


def test_contract_rejects_unknown_fields() -> None:
    data = valid_job().model_dump(mode="json")
    data["invented"] = True
    with pytest.raises(ValidationError):
        JobPayload.model_validate(data)


def test_calendar_only_scenario_allows_zero_cycles_and_depth() -> None:
    scenario = valid_job().scenario.model_copy(
        update={"cycles_per_day": 0.0, "depth_of_discharge": 0.0}
    )
    assert ScenarioInput.model_validate(scenario.model_dump()).cycles_per_day == 0


def test_cycling_scenario_rejects_zero_depth() -> None:
    data = valid_job().scenario.model_dump()
    data["depth_of_discharge"] = 0.0
    with pytest.raises(ValidationError):
        ScenarioInput.model_validate(data)


def test_soc_window_locates_the_cycle_and_contains_initial_soc() -> None:
    scenario = valid_job().scenario
    assert scenario.soc_window_min == 0.05
    assert scenario.soc_window_max == 0.95

    for update in (
        {"soc_window_min": 0.95, "soc_window_max": 0.05},
        {"soc_window_min": 0.2, "soc_window_max": 0.8, "depth_of_discharge": 0.9},
        {"soc_window_min": 0.2, "soc_window_max": 0.8, "initial_soc": 0.9},
    ):
        data = scenario.model_dump()
        data.update(update)
        with pytest.raises(ValidationError):
            ScenarioInput.model_validate(data)


def test_generated_contracts_are_current(tmp_path: Path) -> None:
    export(tmp_path)
    committed = Path("contracts/generated")
    for generated in sorted(tmp_path.iterdir()):
        assert generated.read_bytes() == (committed / generated.name).read_bytes()
