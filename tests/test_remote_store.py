from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest

import compute.remote_store as remote_module
from compute.remote_store import RemoteJobStore, RemoteTransportError
from compute.worker import run_once
from contracts.models import JobPayload, ScenarioInput


class FakeResponse:
    def __init__(self, status: int, payload: dict | bytes | None = None):
        self.status = status
        self.content = (
            b""
            if payload is None
            else payload
            if isinstance(payload, bytes)
            else json.dumps(payload).encode()
        )

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.content


def test_remote_store_requires_tls_outside_localhost(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        RemoteJobStore("http://example.com", "secret", tmp_path)
    assert RemoteJobStore("http://127.0.0.1:3000", "secret", tmp_path)


def test_remote_store_claims_and_renews_a_hosted_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = str(uuid4())
    seen = []

    def fake_open(request, timeout):
        assert timeout == 30
        seen.append(request)
        if request.full_url.endswith("/claim"):
            return FakeResponse(200, {"job": {"job_id": job_id, "contract_version": "3.0"}})
        return FakeResponse(200, {"leaseExpiresAt": "2026-08-12T00:00:00Z"})

    monkeypatch.setattr(remote_module, "urlopen", fake_open)
    store = RemoteJobStore("https://example.com", "secret", tmp_path)

    row = store.claim("worker-a", 60)
    assert row is not None
    assert row["id"] == job_id
    assert store.heartbeat(job_id, "worker-a", 60)
    assert all(request.get_header("Authorization") == "Bearer secret" for request in seen)


def test_remote_completion_uploads_exact_local_artifact_before_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = str(uuid4())
    artifact_names = (
        "manifest.json",
        "scenario-exposure.json",
        "soh-result.json",
        "study-request.json",
    )
    for name in artifact_names:
        (tmp_path / name).write_bytes(b"{}\n")
    checksum = "a" * 64
    methods: list[str] = []

    def fake_open(request, timeout):
        assert timeout == 30
        methods.append(request.get_method())
        if request.get_method() == "PUT":
            assert request.data == b"{}\n"
            kind = request.full_url.rsplit("/", 1)[-1]
            return FakeResponse(
                200,
                {
                    "artifact": {
                        "kind": kind,
                        "objectKey": f"runs/{job_id}/results/{kind}",
                        "contentType": "application/json",
                        "sizeBytes": 3,
                        "checksumSha256": checksum,
                    }
                },
            )
        submitted = json.loads(request.data)
        assert {item["kind"] for item in submitted["artifacts"]} == set(artifact_names)
        return FakeResponse(200, {"status": "completed"})

    monkeypatch.setattr(remote_module, "urlopen", fake_open)
    store = RemoteJobStore("https://example.com", "secret", tmp_path)
    result = {
        "contract_version": "2.0",
        "job_id": job_id,
        "engine": "standard-study",
        "status": "completed",
    }
    registrations = tuple(
        {
            "kind": name,
            "uri": (tmp_path / name).resolve().as_uri(),
            "content_type": "application/json",
            "size_bytes": 3,
            "checksum_sha256": checksum,
        }
        for name in artifact_names
    )

    assert store.complete(job_id, "worker-a", result, registrations)
    assert methods == ["PUT", "PUT", "PUT", "PUT", "POST"]


def test_remote_completion_rejects_partial_bundle_before_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        remote_module,
        "urlopen",
        lambda *_args, **_kwargs: pytest.fail("network must not be called"),
    )
    store = RemoteJobStore("https://example.com", "secret", tmp_path)
    with pytest.raises(ValueError, match="exact artifact bundle"):
        store.complete("job-1", "worker-a", {}, ())


def test_comparison_worker_uses_independent_routes_and_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = str(uuid4())
    names = (
        "comparison-manifest.json",
        "comparison-request.json",
        "comparison-result.json",
    )
    for name in names:
        (tmp_path / name).write_bytes(b"{}\n")
    checksum = "b" * 64
    urls: list[str] = []

    def fake_open(request, timeout):
        assert timeout == 30
        urls.append(request.full_url)
        if request.get_method() == "PUT":
            kind = request.full_url.rsplit("/", 1)[-1]
            return FakeResponse(200, {"artifact": {
                "kind": kind,
                "objectKey": f"comparisons/{job_id}/results/{kind}",
                "contentType": "application/json",
                "sizeBytes": 3,
                "checksumSha256": checksum,
            }})
        return FakeResponse(200, {"status": "completed"})

    monkeypatch.setattr(remote_module, "urlopen", fake_open)
    store = RemoteJobStore(
        "https://example.com", "secret", tmp_path, "study-comparison"
    )
    registrations = tuple(
        {
            "kind": name,
            "uri": (tmp_path / name).resolve().as_uri(),
            "content_type": "application/json",
            "size_bytes": 3,
            "checksum_sha256": checksum,
        }
        for name in names
    )
    assert store.complete(job_id, "worker-a", {}, registrations)
    assert all("/api/worker/comparisons/" in url for url in urls)


def test_dataset_revision_claim_downloads_and_verifies_private_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = str(uuid4())
    source = b"timestamp,voltage_v\n2026-01-01T00:00:00Z,3.2\n"
    checksum = hashlib.sha256(source).hexdigest()
    payload = {
        "job_id": job_id,
        "engine": "dataset-revision",
        "source_file_name": "measured.csv",
    }

    def fake_open(request, timeout):
        assert timeout == 30
        if request.full_url.endswith("/claim"):
            return FakeResponse(200, {
                "job": payload,
                "source": {
                    "downloadUrl": f"/api/worker/dataset-revisions/{job_id}/source",
                    "fileName": "measured.csv",
                    "sizeBytes": len(source),
                    "checksumSha256": checksum,
                },
            })
        assert request.get_header("X-worker-id") == "worker-a"
        return FakeResponse(200, source)

    monkeypatch.setattr(remote_module, "urlopen", fake_open)
    store = RemoteJobStore(
        "https://example.com", "secret", tmp_path, "dataset-revision"
    )
    row = store.claim("worker-a")
    assert row is not None
    assert Path(row["source_path"]).read_bytes() == source
    assert Path(row["source_path"]).name == "measured.csv"
    assert job_id in Path(row["source_path"]).parts


def test_retryable_completion_outage_does_not_mark_model_failed(tmp_path: Path) -> None:
    payload = JobPayload(
        job_id=uuid4(),
        scenario_id=uuid4(),
        user_id="alex",
        engine="stub",
        model_version="stub-1",
        code_revision="1234567",
        scenario=ScenarioInput(
            name="transport-retry",
            horizon_years=1,
            cycles_per_day=0,
            depth_of_discharge=0,
            soc_window_min=0,
            soc_window_max=1,
            ambient_temperature_c=25,
            initial_soc=0.5,
            end_of_life_fraction=0.8,
        ),
    )

    class UnavailableCompletionStore:
        failed = False

        def claim(self, _worker_id, lease_seconds):
            assert lease_seconds == 60
            return {
                "id": str(payload.job_id),
                "payload": payload.model_dump_json(),
            }

        def heartbeat(self, *_args):
            return True

        def complete(self, *_args):
            raise RemoteTransportError("temporary outage")

        def fail(self, *_args):
            self.failed = True
            return True

    store = UnavailableCompletionStore()
    assert run_once(store, "worker-a", artifact_root=tmp_path)
    assert store.failed is False
