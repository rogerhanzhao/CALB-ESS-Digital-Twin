from uuid import uuid4

import pytest
from pydantic import ValidationError

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
