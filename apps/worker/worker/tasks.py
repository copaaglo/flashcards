import io
import os

import boto3
import psycopg
from pypdf import PdfReader

from worker.llm import generate_study_set

DATABASE_URL = os.environ["DATABASE_URL"]
S3_ENDPOINT = os.environ["S3_ENDPOINT"]
S3_BUCKET = os.environ["S3_BUCKET"]

s3 = boto3.client("s3", endpoint_url=S3_ENDPOINT)


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
        except Exception as e:
            conn.rollback()
            set_status(conn, job_id, "failed", error=str(e))
            raise  # re-raise so RQ also records the failure
