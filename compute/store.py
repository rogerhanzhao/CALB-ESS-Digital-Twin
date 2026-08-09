"""SQLite-backed local queue with leases, heartbeats, and checkpoints."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path


def utcnow() -> datetime:
    return datetime.now(UTC)


class JobStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    worker_id TEXT,
                    lease_expires_at TEXT,
                    heartbeat_at TEXT,
                    checkpoint TEXT,
                    result TEXT,
                    error TEXT,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )

    def enqueue(self, job_id: str, payload: dict) -> bool:
        now = utcnow().isoformat()
        with self.connect() as db:
            cursor = db.execute(
                "INSERT OR IGNORE INTO jobs(id,payload,created_at,updated_at) VALUES(?,?,?,?)",
                (job_id, json.dumps(payload), now, now),
            )
            return cursor.rowcount == 1

    def claim(self, worker_id: str, lease_seconds: int = 60) -> dict | None:
        now = utcnow()
        expires = (now + timedelta(seconds=lease_seconds)).isoformat()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT * FROM jobs
                WHERE status = 'queued'
                   OR (status = 'running' AND lease_expires_at < ?)
                ORDER BY created_at LIMIT 1
                """,
                (now.isoformat(),),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            updated = db.execute(
                """
                UPDATE jobs SET status='running', worker_id=?, lease_expires_at=?,
                    heartbeat_at=?, attempt=attempt+1, updated_at=?
                WHERE id=? AND (status='queued' OR lease_expires_at < ?)
                """,
                (worker_id, expires, now.isoformat(), now.isoformat(), row["id"], now.isoformat()),
            )
            db.execute("COMMIT")
            if updated.rowcount != 1:
                return None
            return self.get(row["id"])

    def heartbeat(self, job_id: str, worker_id: str, lease_seconds: int = 60) -> bool:
        now = utcnow()
        expires = (now + timedelta(seconds=lease_seconds)).isoformat()
        with self.connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, updated_at=?
                   WHERE id=? AND worker_id=? AND status='running'""",
                (now.isoformat(), expires, now.isoformat(), job_id, worker_id),
            )
            return cursor.rowcount == 1

    def checkpoint(self, job_id: str, worker_id: str, value: dict) -> bool:
        with self.connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET checkpoint=?, updated_at=?
                   WHERE id=? AND worker_id=? AND status='running'""",
                (json.dumps(value), utcnow().isoformat(), job_id, worker_id),
            )
            return cursor.rowcount == 1

    def complete(self, job_id: str, worker_id: str, result: dict) -> bool:
        with self.connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status='completed', result=?, lease_expires_at=NULL,
                   updated_at=? WHERE id=? AND worker_id=? AND status='running'""",
                (json.dumps(result), utcnow().isoformat(), job_id, worker_id),
            )
            return cursor.rowcount == 1

    def fail(self, job_id: str, worker_id: str, error: str) -> bool:
        with self.connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status='failed', error=?, lease_expires_at=NULL,
                   updated_at=? WHERE id=? AND worker_id=? AND status='running'""",
                (error, utcnow().isoformat(), job_id, worker_id),
            )
            return cursor.rowcount == 1

    def get(self, job_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return dict(row) if row else None
