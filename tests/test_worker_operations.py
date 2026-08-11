import json
import time

from compute.healthcheck import status_is_fresh
from compute.remote_store import RemoteTransportError
from compute.worker import run_cycle, write_worker_status


class UnavailableStore:
    def claim(self, _worker_id, lease_seconds):
        assert lease_seconds == 60
        raise RemoteTransportError("offline")


def test_run_cycle_distinguishes_control_plane_outage_from_an_empty_queue():
    assert run_cycle(UnavailableStore(), "worker-a") == "transport_error"


def test_worker_status_is_atomic_machine_readable_and_fresh(tmp_path):
    path = tmp_path / "status.json"
    write_worker_status(
        path,
        worker_id="worker-a",
        job_kind="dataset-revision",
        cycle_status="idle",
        consecutive_transport_errors=0,
    )
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "V1"
    assert payload["job_kind"] == "dataset-revision"
    assert status_is_fresh(path, 10)


def test_worker_health_rejects_stale_or_invalid_status(tmp_path):
    path = tmp_path / "status.json"
    path.write_text(json.dumps({"observed_at_epoch_seconds": time.time() - 120}), encoding="utf-8")
    assert not status_is_fresh(path, 90)
    path.write_text("not-json", encoding="utf-8")
    assert not status_is_fresh(path, 90)
