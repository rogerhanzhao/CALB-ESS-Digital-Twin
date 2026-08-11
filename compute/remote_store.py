"""HTTP transport from a Python compute worker to the hosted Sites control plane."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from .store import ArtifactRegistration

EXPECTED_STANDARD_STUDY_ARTIFACTS = {
    "manifest.json",
    "scenario-exposure.json",
    "soh-result.json",
    "study-request.json",
}
EXPECTED_STUDY_COMPARISON_ARTIFACTS = {
    "comparison-manifest.json",
    "comparison-request.json",
    "comparison-result.json",
}
BASE_DATASET_REVISION_ARTIFACTS = {
    "dataset-revision-result.json",
    "revision-manifest.json",
    "revision-request.json",
    "validation-report.json",
}


class RemoteTransportError(RuntimeError):
    """A retryable failure to reach or receive a usable response from the control plane."""


class RemoteJobStore:
    def __init__(
        self,
        base_url: str,
        token: str,
        local_artifact_root: Path,
        job_kind: str = "standard-study",
    ):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost"}:
            raise ValueError("remote worker API must use HTTPS except on localhost")
        if not token:
            raise ValueError("remote worker API token must not be empty")
        if job_kind not in {"standard-study", "study-comparison", "dataset-revision"}:
            raise ValueError(
                "remote job kind must be standard-study, study-comparison, or dataset-revision"
            )
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.local_artifact_root = local_artifact_root
        self.job_kind = job_kind
        self.route_prefix = {
            "standard-study": "/api/worker/jobs",
            "study-comparison": "/api/worker/comparisons",
            "dataset-revision": "/api/worker/dataset-revisions",
        }[job_kind]

    def claim(self, worker_id: str, lease_seconds: int = 60) -> dict[str, Any] | None:
        response = self._json_request(
            "POST",
            f"{self.route_prefix}/claim",
            {"workerId": worker_id, "leaseSeconds": lease_seconds},
            accepted=(200, 204, 409),
        )
        if response is None or response.get("job") is None:
            return None
        payload = response["job"]
        if not isinstance(payload, dict) or not isinstance(payload.get("job_id"), str):
            raise TypeError("hosted worker API returned an invalid job payload")
        row = {"id": payload["job_id"], "payload": json.dumps(payload)}
        if self.job_kind == "dataset-revision":
            source = response.get("source")
            if not isinstance(source, dict):
                raise TypeError("hosted dataset-revision claim omitted source evidence")
            row["source_path"] = str(self._download_source(payload, source, worker_id))
        return row

    def heartbeat(self, job_id: str, worker_id: str, lease_seconds: int = 60) -> bool:
        response = self._json_request(
            "POST",
            f"{self.route_prefix}/{quote(job_id, safe='')}/heartbeat",
            {"workerId": worker_id, "leaseSeconds": lease_seconds},
            accepted=(200, 409),
        )
        return response is not None and "leaseExpiresAt" in response

    def complete(
        self,
        job_id: str,
        worker_id: str,
        result: dict[str, Any],
        artifacts: tuple[ArtifactRegistration, ...] = (),
    ) -> bool:
        expected = self._expected_artifacts(result)
        kinds = {item["kind"] for item in artifacts}
        if len(artifacts) != len(expected) or kinds != expected:
            raise ValueError(
                f"hosted {self.job_kind} completion requires its exact artifact bundle"
            )
        uploaded = [self._upload_artifact(job_id, worker_id, item) for item in artifacts]
        response = self._json_request(
            "POST",
            f"{self.route_prefix}/{quote(job_id, safe='')}/complete",
            {"workerId": worker_id, "result": result, "artifacts": uploaded},
            accepted=(200, 409),
        )
        return response is not None and response.get("status") == "completed"

    def fail(self, job_id: str, worker_id: str, error: str) -> bool:
        response = self._json_request(
            "POST",
            f"{self.route_prefix}/{quote(job_id, safe='')}/fail",
            {"workerId": worker_id, "error": error[:4000]},
            accepted=(200, 409),
        )
        return response is not None and response.get("status") == "failed"

    def _expected_artifacts(self, result: dict[str, Any]) -> set[str]:
        if self.job_kind == "standard-study":
            return EXPECTED_STANDARD_STUDY_ARTIFACTS
        if self.job_kind == "study-comparison":
            return EXPECTED_STUDY_COMPARISON_ARTIFACTS
        expected = set(BASE_DATASET_REVISION_ARTIFACTS)
        if result.get("canonical_available") is True:
            expected.add("canonical.csv")
        if result.get("cycle_metrics_available") is True:
            expected.add("cycle-metrics.json")
        return expected

    def _download_source(
        self, payload: dict[str, Any], source: dict[str, Any], worker_id: str
    ) -> Path:
        job_id = payload.get("job_id")
        file_name = source.get("fileName")
        checksum = source.get("checksumSha256")
        size_bytes = source.get("sizeBytes")
        url = source.get("downloadUrl")
        if (
            not isinstance(job_id, str)
            or not isinstance(file_name, str)
            or not file_name
            or file_name in {".", ".."}
            or any(character in file_name for character in ("/", "\\", "\0"))
            or not isinstance(checksum, str)
            or len(checksum) != 64
            or not isinstance(size_bytes, int)
            or size_bytes < 0
            or size_bytes > 25 * 1024 * 1024
            or not isinstance(url, str)
            or not url.startswith(f"{self.route_prefix}/{quote(job_id, safe='')}/")
        ):
            raise TypeError("hosted worker API returned invalid source metadata")
        request = Request(
            f"{self.base_url}{url}",
            method="GET",
            headers={
                "Authorization": f"Bearer {self.token}",
                "X-Worker-Id": worker_id,
            },
        )
        content = self._open_bytes(request, accepted=(200,))
        if len(content) != size_bytes or hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError("downloaded dataset source failed integrity validation")
        directory = self.local_artifact_root.resolve() / job_id / "source"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / file_name
        path.write_bytes(content)
        return path

    def _upload_artifact(
        self, job_id: str, worker_id: str, artifact: ArtifactRegistration
    ) -> dict[str, Any]:
        uri = urlparse(artifact["uri"])
        if uri.scheme != "file":
            raise ValueError("hosted upload accepts only worker-local file artifacts")
        path = Path(uri.path.lstrip("/") if uri.netloc else uri.path)
        if uri.netloc:
            path = Path(f"//{uri.netloc}{uri.path}")
        elif len(uri.path) >= 3 and uri.path[0] == "/" and uri.path[2] == ":":
            path = Path(uri.path[1:])
        content = path.read_bytes()
        request = Request(
            f"{self.base_url}{self.route_prefix}/{quote(job_id, safe='')}/artifacts/"
            f"{quote(artifact['kind'], safe='')}",
            data=content,
            method="PUT",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": artifact["content_type"],
                "X-Worker-Id": worker_id,
                "X-Content-Sha256": artifact["checksum_sha256"],
            },
        )
        payload = self._open_json(request, accepted=(200,))
        uploaded = payload.get("artifact")
        if not isinstance(uploaded, dict):
            raise TypeError("hosted worker API returned invalid artifact metadata")
        return uploaded

    def _json_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any],
        accepted: tuple[int, ...],
    ) -> dict[str, Any] | None:
        request = Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        return self._open_json(request, accepted)

    @staticmethod
    def _open_json(request: Request, accepted: tuple[int, ...]) -> dict[str, Any] | None:
        status, content = RemoteJobStore._open(request)
        if status not in accepted:
            RemoteJobStore._raise_status(status, content)
        if status == 204 or not content:
            return None
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise TypeError("hosted worker API returned a non-object response")
        return parsed

    @staticmethod
    def _open_bytes(request: Request, accepted: tuple[int, ...]) -> bytes:
        status, content = RemoteJobStore._open(request)
        if status not in accepted:
            RemoteJobStore._raise_status(status, content)
        return content

    @staticmethod
    def _open(request: Request) -> tuple[int, bytes]:
        try:
            with urlopen(request, timeout=30) as response:
                status = response.status
                content = response.read()
        except HTTPError as error:
            status = error.code
            content = error.read()
        except URLError as error:
            raise RemoteTransportError(f"hosted worker API is unavailable: {error.reason}") from error
        return status, content

    @staticmethod
    def _raise_status(status: int, content: bytes) -> None:
        detail = content.decode("utf-8", errors="replace")[:1000]
        if status >= 500:
            raise RemoteTransportError(
                f"hosted worker API returned retryable HTTP {status}: {detail}"
            )
        raise RuntimeError(f"hosted worker API returned HTTP {status}: {detail}")
