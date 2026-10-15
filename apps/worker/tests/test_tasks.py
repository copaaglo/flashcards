import io
from unittest.mock import MagicMock

import pytest

from tests.pdfs import CORRUPTED, image_only_pdf, text_pdf
from worker import tasks
from worker.llm import Card, StudySet

JOB_ID = "11111111-1111-1111-1111-111111111111"


class FakeConn:
    """Records what process_job writes so tests can check the job's final state."""

    def __init__(self):
        self.statuses = []  # every (status, error) the job went through
        self.summary = None
        self.cards = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        result = MagicMock()
        if sql.startswith("SELECT s3_key"):
            result.fetchone.return_value = (f"uploads/{JOB_ID}.pdf",)
        elif sql.startswith("UPDATE jobs SET status"):
            self.statuses.append((params[0], params[1]))
        elif sql.startswith("UPDATE jobs SET summary"):
            self.summary = params[0]
        elif sql.startswith("INSERT INTO cards"):
            self.cards.append((params[1], params[2]))
        return result

    def commit(self):
        pass

    def rollback(self):
        # Real Postgres would throw away uncommitted writes, so do the same
        self.summary = None
        self.cards = []


@pytest.fixture
def conn(monkeypatch):
    fake = FakeConn()
    monkeypatch.setattr(tasks.psycopg, "connect", lambda *a, **k: fake)
    return fake


def stored_pdf(monkeypatch, pdf_bytes):
    """Make the fake S3 return these bytes for any get_object call."""
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": io.BytesIO(pdf_bytes)}
    monkeypatch.setattr(tasks, "s3", s3)


def fake_llm(monkeypatch, study_set):
    calls = []

    def generate(text):
        calls.append(text)
        return study_set

    # Patch the name tasks.py actually uses (it did "from worker.llm import ...")
    monkeypatch.setattr(tasks, "generate_study_set", generate)
    return calls


def test_extract_text_reads_text_layer():
    text = tasks.extract_text(text_pdf(["TCP is connection oriented."]))
    assert "TCP is connection oriented." in text


def test_extract_text_of_image_only_pdf_is_empty():
    assert tasks.extract_text(image_only_pdf()).strip() == ""


# 1.1 Happy path: job ends done, summary and cards saved
def test_process_job_happy_path(monkeypatch, conn):
    stored_pdf(monkeypatch, text_pdf(["Lecture 3: TCP vs UDP"]))
    study_set = StudySet(
        summary="TCP is reliable, UDP is fast.",
        cards=[Card(question="Is UDP reliable?", answer="No.")],
    )
    calls = fake_llm(monkeypatch, study_set)

    tasks.process_job(JOB_ID)

    assert [s for s, _ in conn.statuses] == ["processing", "done"]
    assert conn.summary == "TCP is reliable, UDP is fast."
    assert conn.cards == [("Is UDP reliable?", "No.")]
    assert "Lecture 3: TCP vs UDP" in calls[0]  # the LLM got the PDF's text


# 4.1 Image-only PDF fails with a clear message and never reaches the LLM
def test_process_job_image_only_pdf_fails(monkeypatch, conn):
    stored_pdf(monkeypatch, image_only_pdf())
    calls = fake_llm(monkeypatch, None)

    with pytest.raises(ValueError):
        tasks.process_job(JOB_ID)

    status, error = conn.statuses[-1]
    assert status == "failed"
    assert "No text found in PDF" in error
    assert calls == []


# 4.2 Corrupted PDF: any error is fine, as long as the job ends failed (not stuck)
def test_process_job_corrupted_pdf_fails(monkeypatch, conn):
    stored_pdf(monkeypatch, CORRUPTED)
    fake_llm(monkeypatch, None)

    with pytest.raises(Exception):  # noqa: B017
        tasks.process_job(JOB_ID)

    status, error = conn.statuses[-1]
    assert status == "failed"
    assert error


# 4.3 (mocked) The LLM blows up mid-job: job fails and no half-written cards remain
def test_process_job_llm_error_fails_cleanly(monkeypatch, conn):
    stored_pdf(monkeypatch, text_pdf(["Some lecture"]))

    def broken(text):
        raise RuntimeError("401 authentication_error")

    monkeypatch.setattr(tasks, "generate_study_set", broken)

    with pytest.raises(RuntimeError):
        tasks.process_job(JOB_ID)

    assert conn.statuses[-1] == ("failed", "401 authentication_error")
    assert conn.cards == []
