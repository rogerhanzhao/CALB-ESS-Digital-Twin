"""Worker loop. The stub engine proves lifecycle behavior without claiming model output."""

from __future__ import annotations

import argparse
import socket
import time
from pathlib import Path

from calb_ess_digital_twin.pybamm_models.runner import run_spme_reference
from contracts.models import JobPayload, RunResult, Uncertainty

from .store import JobStore


def execute_job(payload: JobPayload) -> RunResult:
    if payload.engine == "pybamm-spme":
        result, _ = run_spme_reference(payload)
        return result
    if payload.engine != "stub":
        raise ValueError(f"engine is not implemented by this worker: {payload.engine}")
    return RunResult(
        job_id=payload.job_id,
        engine="stub",
        model_version=payload.model_version,
        code_revision=payload.code_revision,
        status="completed",
        points=[],
        end_soh=None,
        within_validity_envelope=None,
        uncertainty=Uncertainty(confidence_level=0.95, source="not_available"),
        warnings=["Stub lifecycle result; no electrochemical or SOH calculation was executed."],
    )


def run_once(store: JobStore, worker_id: str) -> bool:
    row = store.claim(worker_id)
    if row is None:
        return False
    job_id = row["id"]
    try:
        payload = JobPayload.model_validate_json(row["payload"])
        store.checkpoint(job_id, worker_id, {"phase": "validated"})
        result = execute_job(payload)
        if not store.complete(job_id, worker_id, result.model_dump(mode="json")):
            raise RuntimeError("worker lost its lease before completion")
    # A worker boundary must convert every job failure into durable state so the
    # process survives malformed payloads and numerical-engine exceptions.
    except Exception as exc:  # noqa: BLE001
        store.fail(job_id, worker_id, str(exc))
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=Path("data/interim/jobs.sqlite3"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    args = parser.parse_args()
    store = JobStore(args.db)
    worker_id = socket.gethostname()
    while True:
        worked = run_once(store, worker_id)
        if args.once:
            break
        if not worked:
            time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
