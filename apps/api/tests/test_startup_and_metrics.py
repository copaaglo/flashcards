import psycopg
import pytest

import main


@pytest.fixture
def no_sleep(monkeypatch):
    sleeps = []
    monkeypatch.setattr(main.time, "sleep", sleeps.append)
    return sleeps


def test_wait_for_db_retries_until_postgres_answers(monkeypatch, no_sleep):
    attempts = []

    def connect(*args, **kwargs):
        attempts.append(kwargs)
        if len(attempts) < 3:
            raise psycopg.OperationalError("connection refused")
        return "connection"

    monkeypatch.setattr(main.psycopg, "connect", connect)

    assert main.wait_for_db(timeout=60) == "connection"
    assert len(attempts) == 3
    assert no_sleep == [2, 4]  # backs off between attempts
    assert attempts[0]["connect_timeout"] == 5  # never hangs on one attempt


def test_wait_for_db_gives_up_after_timeout(monkeypatch, no_sleep):
    def connect(*args, **kwargs):
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr(main.psycopg, "connect", connect)

    with pytest.raises(psycopg.OperationalError):
        main.wait_for_db(timeout=0)


def test_metrics_endpoint_reports_requests_and_queue(client, queue):
    queue.count = 3
    queue.started_job_registry.count = 1
    queue.get_job_ids.return_value = []
    client.get("/jobs/00000000-0000-0000-0000-000000000000")  # a 404, still counted

    body = client.get("/metrics").text

    assert "flashcards_queue_jobs 3.0" in body
    assert "flashcards_queue_jobs_in_progress 1.0" in body
    assert "flashcards_queue_oldest_job_age_seconds 0.0" in body
    # Labelled by route template, never by the real job ID
    assert 'handler="/jobs/{job_id}"' in body
    assert "00000000-0000" not in body


def test_metrics_survive_redis_outage(client, queue):
    queue.count = 0
    queue.started_job_registry.count = 0
    queue.get_job_ids.side_effect = main.redis.exceptions.ConnectionError("redis is down")

    res = client.get("/metrics")

    assert res.status_code == 200  # Prometheus still gets the other metrics
    assert "flashcards_queue_oldest_job_age_seconds NaN" in res.text
