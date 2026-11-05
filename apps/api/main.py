import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import boto3
import psycopg
import redis
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, UploadFile
from prometheus_client import Gauge
from prometheus_fastapi_instrumentator import Instrumentator
from redis import Redis
from rq import Queue

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.environ["REDIS_URL"]
S3_ENDPOINT = os.environ.get("S3_ENDPOINT") or None  # unset or empty = real AWS S3
S3_BUCKET = os.environ["S3_BUCKET"]
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB
# How long startup keeps retrying the database before giving up (and letting Kubernetes restart us)
DB_WAIT_SECONDS = float(os.environ.get("DB_WAIT_SECONDS", "120"))

# Uvicorn's own logger, so our lines come out in the same format as its startup lines
log = logging.getLogger("uvicorn.error")

s3 = boto3.client("s3", endpoint_url=S3_ENDPOINT)
queue = Queue("jobs", connection=Redis.from_url(REDIS_URL))

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    filename TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    summary TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cards (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL
);
"""


def wait_for_db(timeout: float = DB_WAIT_SECONDS) -> psycopg.Connection:
    """Connect to Postgres, retrying while it isn't reachable yet.

    In the cloud the database (or the Secret with its address) can show up a minute
    after this pod does. Retrying here turns that into a slow start instead of a crash loop.
    """
    deadline = time.monotonic() + timeout
    attempt = 0
    while True:
        attempt += 1
        try:
            return psycopg.connect(DATABASE_URL, connect_timeout=5)
        except psycopg.OperationalError as e:
            if time.monotonic() >= deadline:
                raise
            delay = min(2**attempt, 10)  # 2, 4, 8, 10, 10, ... seconds
            log.warning("Database not ready (attempt %d), retrying in %ds: %s", attempt, delay, e)
            time.sleep(delay)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Phase 1 shortcut: create tables and bucket on startup.
    # Real teams use migrations (Alembic) and Terraform for this.
    with wait_for_db() as conn:
        conn.execute(SCHEMA)
    try:
        s3.head_bucket(Bucket=S3_BUCKET)
    except ClientError:
        s3.create_bucket(Bucket=S3_BUCKET)
    yield


app = FastAPI(title="Flashcards API", lifespan=lifespan)

# Request count and latency for every route, served at /metrics for Prometheus.
# Routes are labelled by template (/jobs/{job_id}), not by the real ID, so the
# number of time series stays small no matter how many jobs there are.
Instrumentator(excluded_handlers=["/health", "/metrics"]).instrument(app).expose(
    app, include_in_schema=False
)


def queue_metric(read):
    """Wrap a Redis read so a Redis outage shows up as a missing value, not a broken /metrics."""

    def safe_read():
        try:
            return read()
        except redis.exceptions.RedisError:
            return float("nan")

    return safe_read


def oldest_queued_job_age() -> float:
    job_ids = queue.get_job_ids(0, 1)  # the job at the front of the line
    job = queue.fetch_job(job_ids[0]) if job_ids else None
    if job is None or job.enqueued_at is None:
        return 0
    enqueued_at = job.enqueued_at
    if enqueued_at.tzinfo is None:
        enqueued_at = enqueued_at.replace(tzinfo=UTC)
    return (datetime.now(UTC) - enqueued_at).total_seconds()


# The API reports on the queue, not the worker: when KEDA scales the worker to zero,
# the API is still here to say "3 jobs waiting". Values are read from Redis on every scrape.
Gauge("flashcards_queue_jobs", "Jobs waiting for a worker").set_function(
    queue_metric(lambda: queue.count)
)
Gauge("flashcards_queue_jobs_in_progress", "Jobs a worker is processing right now").set_function(
    queue_metric(lambda: queue.started_job_registry.count)
)
Gauge(
    "flashcards_queue_oldest_job_age_seconds", "How long the oldest waiting job has waited"
).set_function(queue_metric(oldest_queued_job_age))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/jobs", status_code=202)
async def create_job(file: UploadFile):
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "Only PDF files are supported right now")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 20 MB)")

    job_id = uuid.uuid4()
    s3_key = f"uploads/{job_id}.pdf"
    s3.put_object(Bucket=S3_BUCKET, Key=s3_key, Body=data)

    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(
            "INSERT INTO jobs (id, filename, s3_key) VALUES (%s, %s, %s)",
            (job_id, file.filename, s3_key),
        )

    # Enqueue by import path so the API doesn't need the worker's code or deps
    try:
        queue.enqueue("worker.tasks.process_job", str(job_id), job_timeout=600)
    except redis.exceptions.ConnectionError:
        # Nobody will ever process this job, so don't leave it "queued" forever.
        # The client never got the job ID, so deleting the row is safe.
        with psycopg.connect(DATABASE_URL) as conn:
            conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
        raise HTTPException(503, "Job queue is unavailable, please try again shortly") from None
    return {"job_id": str(job_id), "status": "queued"}


@app.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID):
    with psycopg.connect(DATABASE_URL) as conn:
        job = conn.execute(
            "SELECT id, filename, status, summary, error FROM jobs WHERE id = %s",
            (job_id,),
        ).fetchone()
        if job is None:
            raise HTTPException(404, "Job not found")
        cards = conn.execute(
            "SELECT question, answer FROM cards WHERE job_id = %s ORDER BY id",
            (job_id,),
        ).fetchall()

    return {
        "job_id": str(job[0]),
        "filename": job[1],
        "status": job[2],
        "summary": job[3],
        "error": job[4],
        "cards": [{"question": q, "answer": a} for q, a in cards],
    }
