"""Bounded PyBaMM SPMe reference runner for LFP baseline verification."""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from contracts.models import JobPayload, RunResult, Uncertainty

os.environ.setdefault("PYBAMM_DISABLE_TELEMETRY", "true")


@dataclass(frozen=True)
class SpmeSummary:
    parameter_set: str
    duration_seconds: float
    delivered_capacity_ah: float
    initial_voltage_v: float
    final_voltage_v: float
    minimum_voltage_v: float
    maximum_temperature_k: float


def _parameter_set_name(version: str) -> str:
    prefix = "pybamm:"
    if not version.startswith(prefix):
        raise ValueError("cell_param_set_version must use the 'pybamm:<name>' format")
    name = version.removeprefix(prefix)
    if name != "Prada2013":
        raise ValueError("V0.2 reference runner currently approves only pybamm:Prada2013")
    return name


def run_spme_reference(job: JobPayload, c_rate: float = 0.2) -> tuple[RunResult, SpmeSummary]:
    """Run one bounded LFP discharge; this is not a lifetime or warranty model."""
    if job.engine != "pybamm-spme":
        raise ValueError("SPMe runner requires engine='pybamm-spme'")
    if not 0 < c_rate <= 1:
        raise ValueError("reference c_rate must be in (0, 1]")

    import pybamm

    parameter_set = _parameter_set_name(job.scenario.cell_param_set_version)
    parameters = pybamm.ParameterValues(parameter_set)
    nominal_capacity = float(parameters["Nominal cell capacity [A.h]"])
    parameters.update({"Current function [A]": nominal_capacity * c_rate})

    model = pybamm.lithium_ion.SPMe()
    simulation = pybamm.Simulation(model, parameter_values=parameters)
    requested_duration = 3600 / c_rate
    sample_times = np.linspace(0, requested_duration, 121)
    solution = simulation.solve(t_eval=sample_times, initial_soc=job.scenario.initial_soc)

    time_s = np.asarray(solution["Time [s]"].entries, dtype=float)
    voltage_v = np.asarray(solution["Terminal voltage [V]"].entries, dtype=float)
    capacity_ah = np.asarray(solution["Discharge capacity [A.h]"].entries, dtype=float)
    temperature_k = np.asarray(solution["X-averaged cell temperature [K]"].entries, dtype=float)

    summary = SpmeSummary(
        parameter_set=parameter_set,
        duration_seconds=float(time_s[-1]),
        delivered_capacity_ah=float(capacity_ah[-1]),
        initial_voltage_v=float(voltage_v[0]),
        final_voltage_v=float(voltage_v[-1]),
        minimum_voltage_v=float(voltage_v.min()),
        maximum_temperature_k=float(temperature_k.max()),
    )
    result = RunResult(
        job_id=job.job_id,
        engine="pybamm-spme",
        model_version=job.model_version,
        code_revision=job.code_revision,
        status="completed",
        points=[],
        end_soh=None,
        within_validity_envelope=None,
        uncertainty=Uncertainty(confidence_level=0.95, source="not_available"),
        metrics={
            "duration_seconds": summary.duration_seconds,
            "delivered_capacity_ah": summary.delivered_capacity_ah,
            "initial_voltage_v": summary.initial_voltage_v,
            "final_voltage_v": summary.final_voltage_v,
            "minimum_voltage_v": summary.minimum_voltage_v,
            "maximum_temperature_k": summary.maximum_temperature_k,
        },
        warnings=[
            "Reference electrochemical discharge only; no ageing or warranty conclusion was calculated.",
            "Prada2013 is a public LFP reference set, not a CALB production-cell parameter set.",
        ],
    )
    return result, summary
