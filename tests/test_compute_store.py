from datetime import timedelta
from threading import Event
from uuid import uuid4

import compute.worker as worker_module
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
            soc_window_min=0.05,
            soc_window_max=0.95,
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


def test_worker_renews_lease_during_long_execution(tmp_path, monkeypatch) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    payload = JobPayload(
        job_id=uuid4(),
        scenario_id=uuid4(),
        user_id="alex",
        engine="stub",
        model_version="stub-1",
        code_revision="1234567",
        scenario=ScenarioInput(
            name="heartbeat",
            cell_param_set_version=None,
            horizon_years=1,
            cycles_per_day=0.0,
            depth_of_discharge=0.0,
            soc_window_min=0.0,
            soc_window_max=1.0,
            ambient_temperature_c=25.0,
            initial_soc=0.5,
            end_of_life_fraction=0.8,
        ),
    )
    original = worker_module.execute_job
    two_heartbeats_seen = Event()

    def slow_job(job, context):
        assert two_heartbeats_seen.wait(timeout=2), "heartbeat thread did not renew twice"
        return original(job, context)

    monkeypatch.setattr(worker_module, "execute_job", slow_job)
    heartbeats = 0
    original_heartbeat = store.heartbeat

    def counted_heartbeat(*args, **kwargs):
        nonlocal heartbeats
        heartbeats += 1
        if heartbeats >= 2:
            two_heartbeats_seen.set()
        return original_heartbeat(*args, **kwargs)

    monkeypatch.setattr(store, "heartbeat", counted_heartbeat)
    assert store.enqueue(str(payload.job_id), payload.model_dump(mode="json"))
    assert run_once(store, "worker-a", lease_seconds=1, heartbeat_interval=0.04)
    assert heartbeats >= 2
    assert store.get(str(payload.job_id))["status"] == "completed"


def test_reclaimed_job_resumes_from_latest_checkpoint(tmp_path, monkeypatch) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    payload = JobPayload(
        job_id=uuid4(),
        scenario_id=uuid4(),
        user_id="alex",
        engine="stub",
        model_version="stub-1",
        code_revision="1234567",
        scenario=ScenarioInput(
            name="resume",
            cell_param_set_version=None,
            horizon_years=1,
            cycles_per_day=0.0,
            depth_of_discharge=0.0,
            soc_window_min=0.0,
            soc_window_max=1.0,
            ambient_temperature_c=25.0,
            initial_soc=0.5,
            end_of_life_fraction=0.8,
        ),
    )
    job_id = str(payload.job_id)
    assert store.enqueue(job_id, payload.model_dump(mode="json"))
    assert store.claim("worker-a", lease_seconds=1) is not None
    assert store.checkpoint(job_id, "worker-a", {"completed_year": 7})
    with store.connect() as db:
        db.execute(
            "UPDATE jobs SET lease_expires_at=? WHERE id=?",
            ((utcnow() - timedelta(seconds=1)).isoformat(), job_id),
        )

    observed: dict | None = None
    original = worker_module.execute_job

    def observe_resume(job, context):
        nonlocal observed
        observed = context.resume_from
        return original(job, context)

    monkeypatch.setattr(worker_module, "execute_job", observe_resume)
    assert run_once(store, "worker-b")
    assert observed == {"completed_year": 7}
    row = store.get(job_id)
    assert row is not None
    assert row["status"] == "completed"
    assert row["checkpoint"] is None


def test_checkpoint_write_requires_current_lease_owner(tmp_path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.enqueue("job-1", {"job_id": "job-1"})
    assert store.claim("worker-a") is not None
    assert not store.checkpoint("job-1", "worker-b", {"unsafe": True})
    assert store.get_checkpoint("job-1") is None
