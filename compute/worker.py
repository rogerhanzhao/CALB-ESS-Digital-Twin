"""Worker loop. The stub engine proves lifecycle behavior without claiming model output."""

from __future__ import annotations

import argparse
import socket
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Thread

from calb_ess_digital_twin.pybamm_models.runner import run_spme_reference
from contracts.models import JobPayload, RunResult, Uncertainty

from .store import ArtifactRegistration, JobStore


@dataclass(frozen=True)
class ExecutionContext:
    """Durable state offered to an engine without exposing queue ownership details."""

    resume_from: dict | None
    save_checkpoint: Callable[[dict], None]


@dataclass(frozen=True)
class ExecutionOutcome:
    """Everything that becomes visible together when a lease owner completes."""

    result: RunResult
    artifacts: tuple[ArtifactRegistration, ...] = ()


def execute_job(payload: JobPayload, context: ExecutionContext) -> RunResult:
    if payload.engine == "pybamm-spme":
        result, _ = run_spme_reference(payload)
        return result
    if payload.engine != "stub":
        raise ValueError(f"engine is not implemented by this worker: {payload.engine}")
    # The stub proves the durable lifecycle without claiming numerical progress. Real ageing
    # engines will checkpoint solver state or completed time slices through the same callback.
    context.save_checkpoint({"phase": "validated", "resume_from": context.resume_from})
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


def execute_job_with_artifacts(payload: JobPayload, context: ExecutionContext) -> ExecutionOutcome:
    """Stable extension point for evidence-producing job types."""
    return ExecutionOutcome(result=execute_job(payload, context))


@contextmanager
def keep_lease_alive(
    store: JobStore,
    job_id: str,
    worker_id: str,
    lease_seconds: int,
    heartbeat_interval: float,
) -> Iterator[Event]:
    """Renew the lease while numerical work runs and signal if ownership is lost."""
    stop = Event()
    lost = Event()

    def renew() -> None:
        while not stop.wait(heartbeat_interval):
            if not store.heartbeat(job_id, worker_id, lease_seconds):
                lost.set()
                return

    thread = Thread(target=renew, name=f"heartbeat-{job_id}", daemon=True)
    thread.start()
    try:
        yield lost
    finally:
        stop.set()
        thread.join(timeout=max(heartbeat_interval * 2, 1))


def run_once(
    store: JobStore,
    worker_id: str,
    lease_seconds: int = 60,
    heartbeat_interval: float | None = None,
) -> bool:
    row = store.claim(worker_id, lease_seconds=lease_seconds)
    if row is None:
        return False
    job_id = row["id"]
    try:
        payload = JobPayload.model_validate_json(row["payload"])
        interval = heartbeat_interval or max(lease_seconds / 3, 1)

        def save_checkpoint(value: dict) -> None:
            if not store.checkpoint(job_id, worker_id, value):
                raise RuntimeError("worker lost its lease before checkpointing")

        context = ExecutionContext(
            resume_from=store.get_checkpoint(job_id),
            save_checkpoint=save_checkpoint,
        )
        with keep_lease_alive(store, job_id, worker_id, lease_seconds, interval) as lease_lost:
            outcome = execute_job_with_artifacts(payload, context)
        if lease_lost.is_set():
            raise RuntimeError("worker lost its lease during execution")
        if not store.complete(
            job_id, worker_id, outcome.result.model_dump(mode="json"), outcome.artifacts
        ):
            raise RuntimeError("worker lost its lease before completion")
    # A worker boundary must convert every job failure into durable state so the
    # process survives malformed payloads and numerical-engine exceptions.
    except Exception as exc:  # noqa: BLE001
        recorded = store.fail(job_id, worker_id, str(exc))
        if not recorded:
            # A new owner may already be processing an expired lease. Do not overwrite it.
            return True
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
