import io
import logging
import os
import time

import boto3
import psycopg
from prometheus_client import Counter, Histogram
from pypdf import PdfReader

from worker.llm import generate_study_set

DATABASE_URL = os.environ["DATABASE_URL"]
S3_ENDPOINT = os.environ.get("S3_ENDPOINT") or None  # unset or empty = real AWS S3
S3_BUCKET = os.environ["S3_BUCKET"]

s3 = boto3.client("s3", endpoint_url=S3_ENDPOINT)
# RQ's logger: these lines land next to RQ's own "Job OK" lines, and in Loki
log = logging.getLogger("rq.worker")

JOBS = Counter("flashcards_jobs", "Jobs the worker finished, by result", ["status"])
JOB_SECONDS = Histogram(
    "flashcards_job_duration_seconds",
    "Time from a worker picking up a job to the job ending",
    buckets=(1, 2, 5, 10, 20, 30, 60, 120, 300, 600),
)
# Start both counters at 0, so "failed" exists (and rate() works) before the first failure
for status in ("done", "failed"):
    JOBS.labels(status=status)


def set_status(conn, job_id, status, error=None):
    conn.execute(
        "UPDATE jobs SET status = %s, error = %s WHERE id = %s",
        (status, error, job_id),
    )
    conn.commit()


def extract_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def process_job(job_id: str):
    started = time.monotonic()
    status = "failed"
    try:
        cards = run_job(job_id)
        status = "done"
    finally:
        seconds = time.monotonic() - started
        JOBS.labels(status=status).inc()
        JOB_SECONDS.observe(seconds)
        log.info("job=%s status=%s seconds=%.1f", job_id, status, seconds)
    return cards


def run_job(job_id: str) -> int:
    """Do the work. Returns how many cards were saved."""
    with psycopg.connect(DATABASE_URL) as conn:
        row = conn.execute("SELECT s3_key FROM jobs WHERE id = %s", (job_id,)).fetchone()
        if row is None:
            raise ValueError(f"Job {job_id} not found")
        set_status(conn, job_id, "processing")

        try:
            obj = s3.get_object(Bucket=S3_BUCKET, Key=row[0])
            text = extract_text(obj["Body"].read())
            if not text.strip():
                raise ValueError("No text found in PDF (is it a scanned image?)")

            study_set = generate_study_set(text)

            conn.execute("UPDATE jobs SET summary = %s WHERE id = %s", (study_set.summary, job_id))
            for card in study_set.cards:
                conn.execute(
                    "INSERT INTO cards (job_id, question, answer) VALUES (%s, %s, %s)",
                    (job_id, card.question, card.answer),
                )
            set_status(conn, job_id, "done")
            return len(study_set.cards)
        except Exception as e:
            conn.rollback()
            set_status(conn, job_id, "failed", error=str(e))
            raise  # re-raise so RQ also records the failure
