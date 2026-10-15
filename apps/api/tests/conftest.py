import os

# main.py reads these at import time, so set them BEFORE importing it.
# They point nowhere real: the fixtures below replace every outside service.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:8333")
os.environ.setdefault("S3_BUCKET", "test-uploads")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeDB:
    """In-memory stand-in for Postgres. Knows just enough SQL for main.py."""

    def __init__(self):
        self.jobs = {}  # job_id -> (id, filename, status, summary, error)
        self.cards = {}  # job_id -> [(question, answer), ...]

    # psycopg.connect(...) returns a connection used as a context manager
    def connect(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if sql.startswith("INSERT INTO jobs"):
            job_id, filename, _s3_key = params
            self.jobs[job_id] = (job_id, filename, "queued", None, None)
            return FakeResult([])
        if sql.startswith("DELETE FROM jobs"):
            self.jobs.pop(params[0], None)
            return FakeResult([])
        if sql.startswith("SELECT id, filename"):
            row = self.jobs.get(params[0])
            return FakeResult([row] if row else [])
        if sql.startswith("SELECT question"):
            return FakeResult(self.cards.get(params[0], []))
        raise AssertionError(f"FakeDB got SQL it doesn't know: {sql}")


@pytest.fixture
def db(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(main.psycopg, "connect", fake.connect)
    return fake


@pytest.fixture
def s3(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(main, "s3", fake)
    return fake


@pytest.fixture
def queue(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(main, "queue", fake)
    return fake


@pytest.fixture
def client(db, s3, queue):
    # No "with" block on purpose: that skips lifespan, which would try to
    # reach a real Postgres and S3 on startup.
    return TestClient(main.app)
