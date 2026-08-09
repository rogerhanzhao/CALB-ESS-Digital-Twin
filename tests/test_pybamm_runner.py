from uuid import uuid4

from calb_ess_digital_twin.pybamm_models.runner import run_spme_reference
from contracts.models import JobPayload, ScenarioInput


def test_prada2013_spme_reference_discharge() -> None:
    job = JobPayload(
        job_id=uuid4(),
        scenario_id=uuid4(),
        user_id="test",
        engine="pybamm-spme",
        model_version="spme-reference-1",
        code_revision="1234567",
        scenario=ScenarioInput(
            name="LFP SPMe reference",
            cell_param_set_version="pybamm:Prada2013",
            horizon_years=1,
            cycles_per_day=1.0,
            depth_of_discharge=0.9,
            ambient_temperature_c=25.0,
            initial_soc=1.0,
            end_of_life_fraction=0.8,
        ),
    )

    result, summary = run_spme_reference(job, c_rate=0.2)

    assert result.status == "completed"
    assert result.engine == "pybamm-spme"
    assert result.end_soh is None
    assert summary.parameter_set == "Prada2013"
    assert summary.delivered_capacity_ah > 1.5
    assert 1.9 < summary.final_voltage_v < summary.initial_voltage_v < 4.0
    assert any("no ageing" in warning for warning in result.warnings)
