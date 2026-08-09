from datetime import timedelta
from uuid import uuid4

from compute.store import JobStore, utcnow
from compute.worker import run_once
from contracts.models import JobPayload, ScenarioInput


def test_enqueue_is_idempotent(tmp_path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    assert store.enqueue("job-1", {"job_id": "job-1"})
    assert not store.enqueue("job-1", {"job_id": "job-1"})


def test_expired_lease_can_be_reclaimed(tmp_path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.enqueue("job-1", {"job_id": str(uuid4())})
    first = store.claim("worker-a", lease_seconds=1)
    assert first is not None
    with store.connect() as db:
        db.execute(
            "UPDATE jobs SET lease_expires_at=? WHERE id='job-1'",
            ((utcnow() - timedelta(seconds=1)).isoformat(),),
        )
    second = store.claim("worker-b")
    assert second is not None
    assert second["worker_id"] == "worker-b"
    assert second["attempt"] == 2


def test_only_lease_owner_can_complete(tmp_path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.enqueue("job-1", {"job_id": "job-1"})
    assert store.claim("worker-a") is not None
    assert not store.complete("job-1", "worker-b", {"status": "completed"})
    assert store.complete("job-1", "worker-a", {"status": "completed"})


def test_worker_completes_a_valid_stub_job(tmp_path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    job_id = uuid4()
    payload = JobPayload(
        job_id=job_id,
        scenario_id=uuid4(),
        user_id="alex",
        engine="stub",
        model_version="stub-1",
        code_revision="1234567",
        scenario=ScenarioInput(
            name="baseline",
            cell_param_set_version="placeholder-1",
            horizon_years=20,
            cycles_per_day=1.0,
            depth_of_discharge=0.9,
            ambient_temperature_c=25.0,
            initial_soc=0.5,
            end_of_life_fraction=0.8,
        ),
    )
    assert store.enqueue(str(job_id), payload.model_dump(mode="json"))
    assert run_once(store, "worker-a")
    row = store.get(str(job_id))
    assert row is not None
    assert row["status"] == "completed"
    assert "no electrochemical" in row["result"]
