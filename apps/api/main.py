import os
import uuid
from contextlib import asynccontextmanager

import boto3
import psycopg
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, UploadFile
from redis import Redis
from rq import Queue

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.environ["REDIS_URL"]
S3_ENDPOINT = os.environ["S3_ENDPOINT"]
S3_BUCKET = os.environ["S3_BUCKET"]
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Phase 1 shortcut: create tables and bucket on startup.
    # Real teams use migrations (Alembic) and Terraform for this.
    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(SCHEMA)
    try:
        s3.head_bucket(Bucket=S3_BUCKET)
    except ClientError:
        s3.create_bucket(Bucket=S3_BUCKET)
    yield


app = FastAPI(title="Flashcards API", lifespan=lifespan)


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
    queue.enqueue("worker.tasks.process_job", str(job_id), job_timeout=600)
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
