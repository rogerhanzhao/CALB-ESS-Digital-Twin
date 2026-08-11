"""Worker loop. The stub engine proves lifecycle behavior without claiming model output."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
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
from calb_ess_digital_twin.study_comparison import (
    StudyComparisonRequest,
    StudyVersionEvidence,
    load_study_comparison_bundle,
    write_study_comparison_bundle,
)
from contracts.models import (
    ComparisonJobPayload,
    ComparisonJobResult,
    JobPayload,
    RunResult,
    Uncertainty,
)

from .remote_store import RemoteJobStore, RemoteTransportError
from .store import ArtifactRegistration, JobStore

WorkerStore = JobStore | RemoteJobStore
WorkerPayload = JobPayload | ComparisonJobPayload
WorkerResult = RunResult | ComparisonJobResult


class LeaseLostError(RuntimeError):
    """The worker can no longer prove it owns the job and must not publish a result."""


@dataclass(frozen=True)
class ExecutionOutcome:
    result: WorkerResult
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


def execute_job_with_artifacts(payload: WorkerPayload, artifact_root: Path) -> ExecutionOutcome:
    """Execute one job and return result metadata plus immutable artifact registrations."""

    if isinstance(payload, ComparisonJobPayload):
        return _execute_comparison_job(payload, artifact_root)
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


def _execute_comparison_job(
    payload: ComparisonJobPayload, artifact_root: Path
) -> ExecutionOutcome:
    request = StudyComparisonRequest.model_validate(payload.study_comparison_request)
    bundle_directory = artifact_root.resolve() / str(payload.job_id) / "study-comparison"
    if bundle_directory.exists():
        bundle_request, result, _ = load_study_comparison_bundle(bundle_directory)
        if bundle_request != request:
            raise ValueError("existing comparison bundle belongs to a different request")
    else:
        result, _ = write_study_comparison_bundle(request, bundle_directory)

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
    job_result = ComparisonJobResult(
        job_id=payload.job_id,
        code_revision=payload.code_revision,
        status="completed",
        comparison_version=result.comparison_version,
        final_capacity_delta_fraction=result.final_capacity_delta_fraction,
        maximum_absolute_capacity_delta_fraction=(
            result.maximum_absolute_capacity_delta_fraction
        ),
        artifact_checksums=checksums,
    )
    return ExecutionOutcome(result=job_result, artifacts=tuple(registrations))


@contextmanager
def keep_lease_alive(
    store: WorkerStore,
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
            try:
                renewed = store.heartbeat(job_id, worker_id, lease_seconds)
            except Exception:  # noqa: BLE001 - any transport failure makes ownership uncertain
                lost.set()
                return
            if not renewed:
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
    store: WorkerStore,
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
        raw_payload = json.loads(row["payload"])
        payload: WorkerPayload
        if raw_payload.get("engine") == "study-comparison":
            payload = ComparisonJobPayload.model_validate_json(row["payload"])
        else:
            payload = JobPayload.model_validate_json(row["payload"])
        interval = heartbeat_interval or max(lease_seconds / 3, 1)
        with keep_lease_alive(store, job_id, worker_id, lease_seconds, interval) as lease_lost:
            if artifact_root is not None:
                output_root = artifact_root
            elif isinstance(store, RemoteJobStore):
                output_root = store.local_artifact_root
            else:
                output_root = store.path.parent / "artifacts"
            outcome = execute_job_with_artifacts(payload, output_root)
        if lease_lost.is_set():
            raise LeaseLostError("worker lost its lease during execution")
        if not store.complete(
            job_id,
            worker_id,
            outcome.result.model_dump(mode="json"),
            outcome.artifacts,
        ):
            raise LeaseLostError("worker lost its lease before completion")
    except (LeaseLostError, RemoteTransportError):
        # Do not turn uncertain ownership or a temporary control-plane outage into a model
        # failure. The lease expires and an owner can safely reuse the immutable bundle.
        return True
    # A worker boundary must convert every job failure into durable state so the
    # process survives malformed payloads and numerical-engine exceptions.
    except Exception as exc:  # noqa: BLE001
        try:
            recorded = store.fail(job_id, worker_id, str(exc))
        except RemoteTransportError:
            return True
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
    parser.add_argument("--remote-base-url")
    parser.add_argument(
        "--remote-job-kind",
        choices=("standard-study", "study-comparison"),
        default="standard-study",
        help="Select the independent hosted queue polled by this worker process.",
    )
    args = parser.parse_args()
    if args.remote_base_url:
        token = os.environ.get("CALB_ESS_WORKER_API_TOKEN", "")
        if not token:
            parser.error("CALB_ESS_WORKER_API_TOKEN is required with --remote-base-url")
        remote_artifact_root = args.artifact_root or Path("data/interim/remote-artifacts")
        store: WorkerStore = RemoteJobStore(
            args.remote_base_url, token, remote_artifact_root, args.remote_job_kind
        )
    else:
        store = JobStore(args.db)
    worker_id = f"{socket.gethostname()}-{os.getpid()}"
    while True:
        worked = run_once(store, worker_id, artifact_root=args.artifact_root)
        if args.once:
            break
        if not worked:
            time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
