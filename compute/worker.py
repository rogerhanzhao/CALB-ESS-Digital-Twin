"""Worker loop. The stub engine proves lifecycle behavior without claiming model output."""

from __future__ import annotations

import argparse
import hashlib
import socket
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Thread

from calb_ess_digital_twin.pybamm_models.runner import run_spme_reference
from calb_ess_digital_twin.standard_study import (
    StandardStudyRequest,
    load_standard_study_bundle,
    write_standard_study_bundle,
)
from calb_ess_digital_twin.study_comparison import StudyVersionEvidence
from contracts.models import JobPayload, RunResult, Uncertainty

from .store import ArtifactRegistration, JobStore


@dataclass(frozen=True)
class ExecutionOutcome:
    result: RunResult
    artifacts: tuple[ArtifactRegistration, ...] = ()


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


def execute_job_with_artifacts(payload: JobPayload, artifact_root: Path) -> ExecutionOutcome:
    """Execute one job and return result metadata plus immutable artifact registrations."""

    if payload.engine != "standard-study":
        return ExecutionOutcome(result=execute_job(payload))
    request = StandardStudyRequest.model_validate(payload.standard_study_request)
    if payload.model_version != request.calibration.model_version:
        raise ValueError("job model_version does not match standard-study calibration")

    bundle_directory = artifact_root.resolve() / str(payload.job_id) / "standard-study"
    if bundle_directory.exists():
        bundle_request, artifact, manifest = load_standard_study_bundle(bundle_directory)
        if bundle_request != request:
            raise ValueError("existing standard-study bundle belongs to a different request")
    else:
        artifact, manifest = write_standard_study_bundle(request, bundle_directory)
    StudyVersionEvidence(request=request, artifact=artifact, manifest=manifest)

    registrations: list[ArtifactRegistration] = []
    checksums: dict[str, str] = {}
    for path in sorted(bundle_directory.iterdir()):
        content = path.read_bytes()
        checksum = hashlib.sha256(content).hexdigest()
        checksums[path.name] = checksum
        registrations.append(
            ArtifactRegistration(
                kind=path.name,
                uri=path.resolve().as_uri(),
                content_type="application/json",
                size_bytes=len(content),
                checksum_sha256=checksum,
            )
        )

    final_point = artifact.soh_result.points[-1]
    final_capacity = (
        final_point.predicted_capacity_fraction
        if final_point.physically_valid_prediction
        else None
    )
    result = RunResult(
        job_id=payload.job_id,
        engine="standard-study",
        model_version=request.calibration.model_version,
        code_revision=payload.code_revision,
        status="completed",
        points=[],
        end_soh=final_capacity,
        within_validity_envelope=(
            artifact.soh_result.all_points_within_validity_envelope
        ),
        uncertainty=Uncertainty(confidence_level=0.95, source="not_available"),
        metrics={"annual_point_count": float(len(artifact.soh_result.points))},
        warnings=list(artifact.soh_result.warnings),
        artifact_checksums=checksums,
    )
    if manifest.warranty_eligible:
        raise RuntimeError("standard-study manifest must not claim automatic warranty eligibility")
    return ExecutionOutcome(result=result, artifacts=tuple(registrations))


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
    artifact_root: Path | None = None,
) -> bool:
    row = store.claim(worker_id, lease_seconds=lease_seconds)
    if row is None:
        return False
    job_id = row["id"]
    try:
        payload = JobPayload.model_validate_json(row["payload"])
        interval = heartbeat_interval or max(lease_seconds / 3, 1)
        with keep_lease_alive(store, job_id, worker_id, lease_seconds, interval) as lease_lost:
            outcome = execute_job_with_artifacts(
                payload, artifact_root or store.path.parent / "artifacts"
            )
        if lease_lost.is_set():
            raise RuntimeError("worker lost its lease during execution")
        if not store.complete(
            job_id,
            worker_id,
            outcome.result.model_dump(mode="json"),
            outcome.artifacts,
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
    parser.add_argument("--artifact-root", type=Path)
    args = parser.parse_args()
    store = JobStore(args.db)
    worker_id = socket.gethostname()
    while True:
        worked = run_once(store, worker_id, artifact_root=args.artifact_root)
        if args.once:
            break
        if not worked:
            time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
