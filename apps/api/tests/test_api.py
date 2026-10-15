import uuid

import redis
from fastapi.testclient import TestClient

import main

PDF = b"%PDF-1.4\nnot parsed by the API, it only checks the header\n"
MB = 1024 * 1024


def upload(client, data, filename="lecture.pdf"):
    return client.post("/jobs", files={"file": (filename, data, "application/pdf")})


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


# 1.1 Happy path: file goes to S3, job row is created, work is queued
def test_upload_valid_pdf(client, db, s3, queue):
    res = upload(client, PDF)

    assert res.status_code == 202
    body = res.json()
    assert body["status"] == "queued"
    job_id = uuid.UUID(body["job_id"])

    s3.put_object.assert_called_once()
    assert s3.put_object.call_args.kwargs["Key"] == f"uploads/{job_id}.pdf"
    assert s3.put_object.call_args.kwargs["Body"] == PDF

    assert job_id in db.jobs
    queue.enqueue.assert_called_once_with("worker.tasks.process_job", str(job_id), job_timeout=600)


# 1.4 Filenames with spaces and accents are stored as-is
def test_upload_keeps_unicode_filename(client, db):
    res = upload(client, PDF, filename="Lección 5 final.pdf")
    job_id = uuid.UUID(res.json()["job_id"])
    assert db.jobs[job_id][1] == "Lección 5 final.pdf"


# 2.1, 2.2, 2.3 Anything that doesn't start with %PDF is rejected
def test_rejects_non_pdf_files(client, s3, queue):
    cases = {
        "photo.jpg": b"\xff\xd8\xff\xe0 jpeg bytes",
        "notes.zip": b"PK\x05\x06" + b"\x00" * 18,
        "fake.pdf": b"hello, I am definitely a PDF\n",
        "empty.pdf": b"",
    }
    for filename, data in cases.items():
        res = upload(client, data, filename=filename)
        assert res.status_code == 400, filename
        assert res.json()["detail"] == "Only PDF files are supported right now"

    # Rejected uploads must not touch storage or the queue
    s3.put_object.assert_not_called()
    queue.enqueue.assert_not_called()


# 2.4 No file field at all
def test_missing_file_field(client):
    res = client.post("/jobs")
    assert res.status_code == 422


# 2.5 Over the 20 MB API limit
def test_rejects_file_over_20mb(client, s3):
    res = upload(client, b"%PDF-1.4\n" + b"\x00" * (21 * MB))
    assert res.status_code == 413
    s3.put_object.assert_not_called()


# 3.1 Unknown job
def test_unknown_job_returns_404(client):
    res = client.get(f"/jobs/{uuid.uuid4()}")
    assert res.status_code == 404
    assert res.json()["detail"] == "Job not found"


# 3.2 Garbage IDs never reach the database
def test_garbage_job_id_returns_422(client):
    for bad in ["abc", "123", "not-a-uuid", "1' OR '1'='1"]:
        res = client.get(f"/jobs/{bad}")
        assert res.status_code == 422, bad


# Lookup of a finished job returns its summary and cards
def test_get_done_job_with_cards(client, db):
    job_id = uuid.uuid4()
    db.jobs[job_id] = (job_id, "lec.pdf", "done", "A short summary.", None)
    db.cards[job_id] = [("What is TCP?", "A reliable protocol."), ("What is UDP?", "A fast one.")]

    res = client.get(f"/jobs/{job_id}")

    assert res.status_code == 200
    assert res.json() == {
        "job_id": str(job_id),
        "filename": "lec.pdf",
        "status": "done",
        "summary": "A short summary.",
        "error": None,
        "cards": [
            {"question": "What is TCP?", "answer": "A reliable protocol."},
            {"question": "What is UDP?", "answer": "A fast one."},
        ],
    }


# 5.5 Redis down during upload: must not leave a job stuck in "queued" forever
def test_redis_down_does_not_leave_orphan_job(db, s3, queue):
    queue.enqueue.side_effect = redis.exceptions.ConnectionError("Redis is down")
    client = TestClient(main.app, raise_server_exceptions=False)

    res = client.post("/jobs", files={"file": ("lec.pdf", PDF, "application/pdf")})

    assert res.status_code == 503
    stuck = [job for job in db.jobs.values() if job[2] == "queued"]
    assert stuck == [], "a job row was left 'queued' that no worker will ever pick up"
