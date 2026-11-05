# Phase 6: AI Evals in CI, Monitoring, and Autoscaling

Goal for this phase: you can *prove* the app works and *see* it working. By the end:

- Every PR that touches the prompt or the worker runs the real model on sample lectures, scores the output, and **blocks the merge if quality drops**.
- Prometheus scrapes metrics from the api and worker, Grafana shows one dashboard with request latency, jobs, failures, queue length, and LLM tokens and cost, Loki has every pod's logs next to it, and two alerts fire when jobs fail or the queue backs up.
- The worker **scales on the queue with KEDA**: zero pods when there's nothing to do, more pods when uploads pile up. The api scales on CPU with a normal HPA.
- The Phase 5 follow-up is fixed: the api **waits for the database** instead of crash looping when it boots first.

This is build order week 7. Everything runs on your **local kind cluster**, so the only cost is a few cents of Anthropic API per eval run. No AWS in this phase.

**Do it in two sittings.** Steps 0 to 7 are code and CI (about 2 hours). Steps 8 to 12 install the monitoring stack on kind and break things on purpose (about 2 hours).

**Defaults I picked (all explained below):**
- **Evals in plain Python + pytest-style checks**, not promptfoo. You already know pytest, the checks are 100 lines you can read, and the runner calls the worker's real `generate_study_set`, so the eval tests exactly what production runs.
- **Path filter with `git diff`**, not a third-party action, and the eval job feeds the existing **CI passed** check, so a failing eval blocks the merge.
- **kube-prometheus-stack** (Prometheus Operator, Prometheus, Alertmanager, Grafana, kube-state-metrics): the standard way companies run Prometheus on Kubernetes.
- **Loki + Grafana Alloy** for logs. Alloy is Grafana's current collector; Promtail, which older tutorials use, is deprecated.
- **KEDA** for the worker, **HPA** for the api. Two different autoscalers on purpose, because they answer two different questions (more on that in Step 9).
- **Monitoring and autoscaling on kind only for now.** Staging and prod keep them off (`values-staging.yaml`, `values-prod.yaml`). Known gaps explains what bringing them to the cloud would take.

**What I tested and what I couldn't.** I wrote every file in this guide and ran it as far as I could. Unit tests: api 14 passed, worker 13 passed, evals scoring 7 passed, all in `python:3.12-slim` like CI. `ruff`, `helm lint --strict` (all three values files), `actionlint` and `shellcheck` are clean. The rendered chart passes `kubeconform` against the real CRD schemas for KEDA, the Prometheus Operator and External Secrets. On a **throwaway kind cluster** I ran the real app with KEDA 2.21.0 and metrics-server 3.14.0: the api sat in "Database not ready, retrying" with Postgres scaled to 0 (zero restarts, the old pod kept serving), then went Ready when Postgres came back; 10 uploads with a 20s fake delay took the worker from **0 to 4 pods**, and back to 0 after the cooldown; deleting a busy worker printed `warm shut down requested`, finished the job, then exited. Both `/metrics` endpoints returned the numbers you'll see on the dashboard. The eval runner ran end to end in fake mode and failed the gate like it should. For the monitoring stack, `promtool` accepts the alert rules, every PromQL query on the dashboard parses, the dashboard loads in a real Grafana 12, `alloy fmt` accepts the log pipeline, and all three charts render with these values. **What I couldn't do:** run kube-prometheus-stack, Loki and Alloy *live* next to your cluster. Your Docker Desktop has about 4 GB, and with my test cluster plus yours it ran out of memory and started swapping (your api pod even crash looped for a couple of minutes while it was starving, which happens to be exactly the bug Step 1 fixes; it recovered by itself). One cluster with the stack fits, which is why Step 0 gives Docker more memory. I also didn't call the real model, because that's your API key and your money: Step 5 is where you get the first real scores.

## Cost first

| Thing | When | Cost |
|---|---|---|
| Eval run, 8 samples (more if you add PDFs) | Each `run_evals.py` locally, and each PR that touches `apps/worker/` or `evals/` | A few cents to maybe 30 cents, depending on how much the model thinks. Step 5 prints the real number from the token counts. |
| Monitoring, KEDA, metrics-server on kind | While your laptop is on | $0, but about 1.2 GB of memory |
| AWS | Not used in this phase | $0 (both environments stay destroyed) |

**Protect your API key's wallet:** create a **separate Anthropic API key just for CI**, in its own workspace with a monthly spend limit (Step 6). If someone ever leaks it or a workflow loops, the damage is capped. This is how companies treat every credential that leaves a laptop.

## The big picture

```
                          ┌──────────────── GitHub Actions (every PR) ─────────────────┐
                          │ lint, tests, images, Trivy           (as before)           │
                          │ Detect changes ── apps/worker/ or evals/ changed?          │
                          │      └─ yes ─▶ AI evals: 8 lectures ─▶ Claude ─▶ scores     │
                          │                 score < threshold ─▶ CI passed fails ─▶ ✗   │
                          └────────────────────────────────────────────────────────────┘

kind cluster "flashcards"
  namespace flashcards                               namespace monitoring
  ┌───────────────────────────────────────┐          ┌──────────────────────────────────────┐
  │ api ──/metrics (requests, queue)  ◀───┼── scrape ─┤ Prometheus ── rules ─▶ Alertmanager   │
  │  ▲ HPA (CPU, from metrics-server)     │          │     ▲                                 │
  │ worker ──:9100/metrics (jobs, tokens,◀┼── scrape ─┤     │ PodMonitors (from our chart)    │
  │  ▲        cost)                       │          │ Grafana ── dashboard (from our chart) │
  │  │ KEDA ScaledObject ──reads LLEN─────┼─▶ redis   │     └── Loki ◀── Alloy ◀── pod logs   │
  │ postgres, redis, s3 (dev-deps)        │          └──────────────────────────────────────┘
  └───────────────────────────────────────┘          namespace keda: KEDA operator
```

Things to notice:
- **The app describes its own monitoring.** The PodMonitors, alert rules and Grafana dashboard live in *our* Helm chart, next to the Deployments they watch. The platform (Prometheus, Grafana) is installed once; each team's chart plugs into it. That split is how bigger companies organize it.
- **Queue metrics come from the api, not the worker.** When KEDA scales the worker to zero, there's no worker to ask "how many jobs are waiting?". The api is always up, so it reports the queue.
- **CI still never touches the cluster.** Evals run in GitHub Actions against the Anthropic API, nothing else.

### Observability in five minutes

- **Metrics** are numbers over time: "requests per second", "jobs waiting". Your app exposes current values at `/metrics` in a plain text format; **Prometheus** visits (scrapes) that URL every 15 seconds and stores the history.
- **Counter**: only goes up (jobs finished, tokens used). You almost always look at its *rate*: `rate(flashcards_jobs_total[5m])` is jobs per second over the last 5 minutes. Counters reset to 0 when a pod restarts; `rate()` handles that.
- **Gauge**: goes up and down (jobs waiting right now).
- **Histogram**: counts observations into buckets (job took under 10s, under 30s, ...), so you can ask for percentiles: `histogram_quantile(0.95, ...)` is the p95, "95% of jobs were faster than this". Averages hide slow outliers; p95 doesn't.
- **Labels** split a metric: `flashcards_jobs_total{status="failed"}`. Every unique label combination is a separate time series, so never put unbounded values (job IDs, user emails) in a label. That's called a **cardinality explosion** and it's the classic way to kill a Prometheus.
- **PromQL** is the query language. You'll write a few in Step 10.
- **Logs** are the text lines your app prints. **Loki** stores them, indexed only by labels (namespace, pod, container), which keeps it cheap. **Alloy** reads them from Kubernetes and sends them to Loki.
- **Alerts** are PromQL conditions that must stay true for a while (`for: 5m`). Prometheus evaluates them; **Alertmanager** groups them and sends notifications (Slack, email, PagerDuty). Locally we just look at them in the UI.

The industry shorthand is **RED** for request-driven services (Rate, Errors, Duration) and the same idea for queues: how much is waiting, how fast it drains, how often it fails. Our dashboard is exactly that.

## Step 0: Prereqs

1. Phase 5 done, and **both AWS environments destroyed**. This phase never touches AWS. Check nothing is running:
   ```bash
   aws ec2 describe-instances --filters "Name=tag:Project,Values=flashcards" "Name=instance-state-name,Values=running,pending,stopped" --query 'Reservations[].Instances[].InstanceId' --output text
   ```
   Empty output is what you want. (If `aws` says your session expired, run `aws login` first.)

2. **Give Docker Desktop more memory.** The monitoring stack needs about 1.2 GB on top of your app. Docker Desktop > **Settings** > **Resources** > **Memory**: set it to **6 GB** (your Mac has 8 GB, so this still leaves macOS 2 GB), then **Apply & restart**. Also stop containers you aren't using while you do this phase, like `sql-practice`:
   ```bash
   docker ps --format '{{.Names}}'
   ```
   ```bash
   docker stop sql-practice
   ```
   After Docker restarts, wait until your cluster is back:
   ```bash
   kubectl config use-context kind-flashcards
   kubectl get pods -n flashcards
   ```
   All `Running`. If the api shows `CrashLoopBackOff` for a minute, that's the boot-before-database race Step 1 fixes. It sorts itself out after a restart or two.

3. Add the four Helm chart repositories this phase uses:
   ```bash
   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
   helm repo add grafana https://grafana.github.io/helm-charts
   helm repo add kedacore https://kedacore.github.io/charts
   helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
   helm repo update
   ```

4. An Anthropic API key in `.env` (you've had it since Phase 1, it's what the Compose worker uses):
   ```bash
   grep -c '^ANTHROPIC_API_KEY=sk-ant-' .env
   ```
   Should print `1`. (This only counts the line, it never prints the key.)

5. Branch:
   ```bash
   cd ~/flashcards
   git switch main
   git pull
   git switch -c phase6-observability
   git status
   ```
   Check your prompt says `phase6-observability` before you commit anything in this phase. `git status` shows two things I already put in your folder, untracked: `evals/` (8 sample lectures) and `deploy/helm/flashcards/files/dashboard.json` (the Grafana dashboard). They're data, not code to learn from, so I saved you the paste. Both get explained when we use them.

## Step 1: The api waits for the database (and starts reporting metrics)

**The bug from Phase 5:** on a fresh `terraform apply`, Argo CD starts the api while RDS is still booting (or before External Secrets has even built `DATABASE_URL`). The api's startup does `psycopg.connect(...)` once, it fails, the process exits, Kubernetes restarts it, it fails again, and you get `CrashLoopBackOff` with longer and longer waits between tries. It eventually works, but it's noisy and slow, and a crash loop on every deploy trains people to ignore crash loops.

**The fix has three layers, and real teams use all three:**
1. **The app retries.** Startup tries the database for up to 2 minutes, backing off 2s, 4s, 8s, 10s... A dependency that's slow to come up is normal in distributed systems; crashing on it isn't.
2. **A startup probe.** While the app is retrying, `/health` isn't answering yet. With only a liveness probe, Kubernetes would kill it after about 40 seconds. A `startupProbe` says "give it up to 3 minutes to start, and don't run the liveness probe until it has".
3. **Argo CD sync waves** (cloud only). Mark the `SecretStore` and `ExternalSecret` as wave `-1`, and Argo CD applies them first and waits until they're **healthy** (the Secret exists) before it even creates the api and worker.

The same file also gets the api's metrics, so you only replace it once:
- `Instrumentator` (from `prometheus-fastapi-instrumentator`, the standard library for this) adds request count and latency for every route and serves `/metrics`. It labels requests by **route template** (`/jobs/{job_id}`), not the real URL, which keeps cardinality low.
- Three **gauges** for the queue, read from Redis at scrape time: jobs waiting, jobs in progress, and the age of the oldest waiting job (that last one drives the "queue backed up" alert).

`apps/api/main.py`:

```bash
cat > apps/api/main.py <<'EOF'
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
EOF
```

`set_function` means Prometheus' scrape calls our function to get the value, instead of us remembering to update it. `queue_metric` catches Redis errors so one broken metric never takes `/metrics` down with it (then you'd lose the request metrics too, right when you need them).

Add the two packages. The whole file, because the old one has no newline at the end and appending would glue two lines together (I learned that the hard way testing this guide):

```bash
cat > apps/api/requirements.txt <<'EOF'
fastapi==0.143.0
uvicorn[standard]==0.54.0
python-multipart==0.0.32
psycopg[binary]==3.3.6
redis==8.1.0
rq==2.12.0
boto3==1.43.112
prometheus-client==0.26.0
prometheus-fastapi-instrumentator==8.1.0
EOF
```

New tests. They fake the database failing twice, then answering, and check the backoff without actually sleeping (`time.sleep` is swapped for a list that records the delays). The metrics tests check the queue numbers, the route template, and that a Redis outage doesn't break `/metrics`.

`apps/api/tests/test_startup_and_metrics.py`:

```bash
cat > apps/api/tests/test_startup_and_metrics.py <<'EOF'
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
EOF
```

## Step 2: Worker metrics

Three changes in the worker: count jobs and time them, count LLM tokens and cost, and give metrics a place to be served from.

### 2a. A new entrypoint

Until now the Dockerfile ran `rq worker jobs`. Two problems for metrics:
- Nothing in that process serves `/metrics`.
- RQ's default `Worker` **forks a new child process for every job**. Anything the child counts (jobs done, tokens) disappears when the child exits, before Prometheus ever sees it.

So a tiny `worker/main.py` starts a metrics HTTP server on port 9100, then runs a `SimpleWorker`, which runs jobs in the same process. The trade-off: a job that leaks memory or segfaults now takes the whole worker down instead of one child. Kubernetes restarts it, and for our small jobs that's fine. (The other option, Prometheus "multiprocess mode", shares counters between processes through files on disk. It works, but it's fiddly. Worth knowing the name.)

`apps/worker/worker/main.py`:

```bash
cat > apps/worker/worker/main.py <<'EOF'
"""Worker entrypoint: serve Prometheus metrics, then process jobs from the "jobs" queue.

Replaces the plain `rq worker jobs` command so metrics have somewhere to live.
"""

import os

from prometheus_client import start_http_server
from redis import Redis
from rq import Queue, SimpleWorker

METRICS_PORT = int(os.environ.get("METRICS_PORT", "9100"))


def main():
    # /metrics on its own small HTTP server, in a background thread
    start_http_server(METRICS_PORT)

    connection = Redis.from_url(os.environ["REDIS_URL"])
    # SimpleWorker runs each job in this process. The default Worker forks a child per job,
    # and anything the child counts (jobs, tokens, cost) dies with it before Prometheus sees it.
    worker = SimpleWorker([Queue("jobs", connection=connection)], connection=connection)
    # On SIGTERM (a deploy, or KEDA scaling down) RQ finishes the current job, then exits
    worker.work(logging_level="INFO")


if __name__ == "__main__":
    main()
EOF
```

`apps/worker/Dockerfile`:

```bash
cat > apps/worker/Dockerfile <<'EOF'
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker/ worker/

RUN useradd --create-home appuser
USER appuser

# Prometheus scrapes the worker's metrics here
EXPOSE 9100

# worker/main.py serves /metrics, then listens on the "jobs" queue
CMD ["python", "-m", "worker.main"]
EOF
```

The exec form `CMD ["python", ...]` matters: Python is PID 1 and receives Kubernetes' SIGTERM directly, so RQ can do a **warm shutdown** (finish the current job, then exit). With `sh -c` in front, the shell might swallow it.

### 2b. Job metrics

`process_job` now wraps the real work (`run_job`) to count every job as `done` or `failed` and time it, whatever happens inside. The `try/finally` guarantees it's counted even when the job raises. It also logs one summary line per job, which you'll search for in Loki.

`apps/worker/worker/tasks.py`:

```bash
cat > apps/worker/worker/tasks.py <<'EOF'
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
EOF
```

Notice the label values are a fixed set (`done`, `failed`). The job ID goes in the *log line*, never in a metric label.

### 2c. LLM tokens and cost

Every response from the API includes `usage.input_tokens` and `usage.output_tokens` (thinking counts as output). We count both, and multiply by the price to estimate dollars. Claude Opus 5.5 is **$4 per million input tokens and $20 per million output tokens**; check Anthropic's pricing page whenever you change models. If someone sets `LLM_MODEL` to a model that isn't in `PRICES`, tokens still get counted and a warning is logged instead of a wrong number.

`FAKE_LLM_DELAY_SECONDS` is new too: in fake mode the worker sleeps this long, so you can make a queue back up locally for free (Step 11b).

`apps/worker/worker/llm.py`:

```bash
cat > apps/worker/worker/llm.py <<'EOF'
import logging
import os
import time
from pathlib import Path

import anthropic
from prometheus_client import Counter
from pydantic import BaseModel

MODEL = os.environ.get("LLM_MODEL", "claude-opus-5-5")
FAKE_LLM = os.environ.get("FAKE_LLM") == "1"
# Fake mode only: pretend the model takes this long, so a local queue can actually back up
FAKE_LLM_DELAY_SECONDS = float(os.environ.get("FAKE_LLM_DELAY_SECONDS", "0"))
MAX_CHARS = 300_000  # fail loudly instead of silently cutting the lecture off

# Prompts live in versioned files so prompt changes show up in Git diffs
PROMPT = (Path(__file__).parent / "prompts" / "flashcards_v1.txt").read_text()

# US dollars per million tokens (input, output), from Anthropic's pricing page.
# Thinking tokens are billed as output and are included in usage.output_tokens.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
}

log = logging.getLogger("rq.worker")

LLM_TOKENS = Counter("flashcards_llm_tokens", "Tokens used by LLM calls", ["model", "direction"])
LLM_COST = Counter("flashcards_llm_cost_dollars", "Estimated LLM spend in US dollars", ["model"])


class Card(BaseModel):
    question: str
    answer: str


class StudySet(BaseModel):
    summary: str
    cards: list[Card]


def generate_study_set(text: str) -> StudySet:
    if FAKE_LLM:
        time.sleep(FAKE_LLM_DELAY_SECONDS)
        first_line = text.strip().splitlines()[0][:100]
        return StudySet(
            summary=f"(fake) This lecture starts with: {first_line}",
            cards=[
                Card(question=f"(fake) Question {i}?", answer=f"(fake) Answer {i}")
                for i in range(1, 4)
            ],
        )

    if len(text) > MAX_CHARS:
        raise ValueError(f"Lecture is too long ({len(text)} chars, max {MAX_CHARS})")

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=PROMPT,
        messages=[{"role": "user", "content": f"<lecture>\n{text}\n</lecture>"}],
        output_config={"effort": "low"},
        output_format=StudySet,  # the SDK forces valid JSON matching this schema
    )
    record_usage(response.usage)
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to process this document")
    return response.parsed_output


def record_usage(usage) -> None:
    """Count tokens and estimated cost. Refusals are billed too, so this runs for every call."""
    LLM_TOKENS.labels(model=MODEL, direction="input").inc(usage.input_tokens)
    LLM_TOKENS.labels(model=MODEL, direction="output").inc(usage.output_tokens)
    if MODEL not in PRICES:
        log.warning("No price for model %s, cost metric not updated", MODEL)
        return
    input_price, output_price = PRICES[MODEL]
    cost = (usage.input_tokens * input_price + usage.output_tokens * output_price) / 1_000_000
    LLM_COST.labels(model=MODEL).inc(cost)
    log.info(
        "llm model=%s input_tokens=%d output_tokens=%d cost_usd=%.4f",
        MODEL,
        usage.input_tokens,
        usage.output_tokens,
        cost,
    )
EOF
```

```bash
cat > apps/worker/requirements.txt <<'EOF'
anthropic==1.13.0
pydantic==2.14.1
pypdf==6.20.1
psycopg[binary]==3.3.6
redis==8.1.0
rq==2.12.0
boto3==1.43.112
prometheus-client==0.26.0
EOF
```

### 2d. Worker tests

The fake Anthropic responses now need a `usage`, and two new tests check the counters actually move. `REGISTRY.get_sample_value` reads a metric's current value straight out of `prometheus_client`, the same number Prometheus would scrape.

`apps/worker/tests/test_llm.py`:

```bash
cat > apps/worker/tests/test_llm.py <<'EOF'
from types import SimpleNamespace

import pytest
from prometheus_client import REGISTRY

from worker import llm
from worker.llm import Card, StudySet


class FakeAnthropic:
    """Pretends to be anthropic.Anthropic(). Records requests, returns a canned response."""

    requests = []
    response = None

    def __init__(self, *args, **kwargs):
        self.messages = self

    def parse(self, **kwargs):
        FakeAnthropic.requests.append(kwargs)
        return FakeAnthropic.response


USAGE = SimpleNamespace(input_tokens=10_000, output_tokens=2_000)


@pytest.fixture
def fake_client(monkeypatch):
    FakeAnthropic.requests = []
    FakeAnthropic.response = None
    monkeypatch.setattr(llm, "FAKE_LLM", False)
    monkeypatch.setattr(llm.anthropic, "Anthropic", FakeAnthropic)
    return FakeAnthropic


def test_fake_mode_returns_three_cards(monkeypatch):
    monkeypatch.setattr(llm, "FAKE_LLM", True)
    result = llm.generate_study_set("Lecture 3: TCP vs UDP\nmore text")
    assert len(result.cards) == 3
    assert "Lecture 3: TCP vs UDP" in result.summary


def test_sends_lecture_and_prompt_to_model(fake_client):
    expected = StudySet(summary="S", cards=[Card(question="Q?", answer="A")])
    fake_client.response = SimpleNamespace(
        stop_reason="end_turn", parsed_output=expected, usage=USAGE
    )

    result = llm.generate_study_set("Pascal's law")

    assert result == expected
    request = fake_client.requests[0]
    assert request["system"] == llm.PROMPT
    assert request["output_format"] is StudySet
    assert "<lecture>\nPascal's law\n</lecture>" in request["messages"][0]["content"]


def test_refusal_raises(fake_client):
    fake_client.response = SimpleNamespace(stop_reason="refusal", parsed_output=None, usage=USAGE)
    with pytest.raises(RuntimeError, match="declined"):
        llm.generate_study_set("some text")


def test_too_long_lecture_fails_before_calling_model(fake_client):
    with pytest.raises(ValueError, match="too long"):
        llm.generate_study_set("x" * (llm.MAX_CHARS + 1))
    assert fake_client.requests == []  # no money spent


def test_prompt_file_is_loaded():
    assert "flashcards" in llm.PROMPT.lower()


def metric(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0.0


def test_counts_tokens_and_cost(fake_client):
    expected = StudySet(summary="S", cards=[])
    fake_client.response = SimpleNamespace(
        stop_reason="end_turn", parsed_output=expected, usage=USAGE
    )
    model = llm.MODEL
    tokens_before = metric("flashcards_llm_tokens_total", model=model, direction="output")
    cost_before = metric("flashcards_llm_cost_dollars_total", model=model)

    llm.generate_study_set("Pascal's law")

    assert metric("flashcards_llm_tokens_total", model=model, direction="output") == (
        tokens_before + 2_000
    )
    # 10k input at $4/M + 2k output at $20/M = $0.04 + $0.04
    assert metric("flashcards_llm_cost_dollars_total", model=model) == pytest.approx(
        cost_before + 0.08
    )
EOF
```

`apps/worker/tests/test_tasks.py`:

```bash
cat > apps/worker/tests/test_tasks.py <<'EOF'
import io
from unittest.mock import MagicMock

import pytest
from prometheus_client import REGISTRY

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


def jobs_counted(status):
    return REGISTRY.get_sample_value("flashcards_jobs_total", {"status": status})


def test_process_job_counts_done_and_failed(monkeypatch, conn):
    done_before, failed_before = jobs_counted("done"), jobs_counted("failed")

    stored_pdf(monkeypatch, text_pdf(["Lecture 3: TCP vs UDP"]))
    fake_llm(monkeypatch, StudySet(summary="S", cards=[Card(question="Q?", answer="A")]))
    tasks.process_job(JOB_ID)

    stored_pdf(monkeypatch, image_only_pdf())
    with pytest.raises(ValueError):
        tasks.process_job(JOB_ID)

    assert jobs_counted("done") == done_before + 1
    assert jobs_counted("failed") == failed_before + 1
EOF
```

## Step 3: Run the tests

`scripts/ci-local.sh` gets one more block, for the eval scoring tests you'll write in Step 4:

```bash
cat > scripts/ci-local.sh <<'EOF'
#!/usr/bin/env bash
# Runs the same lint and test steps as CI, before you push.
# Python runs inside python:3.12-slim (same version as CI), so your Mac's Python doesn't matter.
# Usage, from the repo root: bash scripts/ci-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

py() {  # py <folder to mount> <command>
  docker run --rm -v "$PWD/$1":/app -w /app -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
    python:3.12-slim sh -c "pip install -q --root-user-action=ignore -r requirements-dev.txt && $2"
}

echo "== ruff (lint + format check)"
py . "ruff check . && ruff format --check ."

for app in api worker; do
  echo "== pytest ($app)"
  py "apps/$app" "pytest -q -p no:cacheprovider"
done

echo "== pytest (evals scoring)"
docker run --rm -v "$PWD":/repo -w /repo/evals -e PIP_DISABLE_PIP_VERSION_CHECK=1 python:3.12-slim \
  sh -c "pip install -q --root-user-action=ignore -r requirements.txt && pytest -q -p no:cacheprovider"

echo "== eslint"
(cd apps/web && npm run lint)

echo "All local checks passed. Safe to push."
EOF
```

Not yet though, since `evals/` has no code yet. For now just the two apps, the Phase 2 way:

```bash
docker run --rm -v "$PWD/apps/api":/app -w /app python:3.12-slim sh -c "pip install -q -r requirements-dev.txt && pytest -q"
```

```bash
docker run --rm -v "$PWD/apps/worker":/app -w /app python:3.12-slim sh -c "pip install -q -r requirements-dev.txt && pytest -q"
```

`14 passed` and `13 passed`. If anything fails, paste the output in the thread.

Quick sanity check that Compose still works with the new worker command (Compose builds from the same Dockerfiles):

```bash
docker compose up --build -d
docker compose logs worker --tail 5
```

You should see `*** Listening on jobs...` from RQ. Then:

```bash
docker compose down
```

## Step 4: AI evals

### Why evals exist

Unit tests check *your* code with the LLM mocked out. They can't tell you whether the cards are any good, and the thing most likely to make them worse isn't a bug: it's a prompt edit, a model upgrade, or a change in how you extract text. An **eval** runs a fixed set of real inputs through the real model and scores the output, so "I tweaked the prompt" becomes "the score went from 0.93 to 0.81, don't merge". Every company shipping LLM features has some version of this. It's the LLM equivalent of a regression test suite.

Two things make evals different from unit tests, and they're good interview material:
- **They're not deterministic.** The same prompt gives slightly different cards each run. So you score on a scale and set a threshold with some margin, instead of asserting exact output.
- **They cost money and time.** So they only run when something that could change the output changed (Step 6's path filter).

### What we score

Four checks per lecture, each from 0.0 to 1.0, averaged into one score. They're deliberately cheap and deterministic: no second LLM call.

| Check | Question it answers | How |
|---|---|---|
| `schema` | Is the output even valid? | Parses as a `StudySet`, at least one card, no empty fields |
| `card_count` | Is the number of cards sensible for the length? | Under 300 words: 5 to 10. Under 1,000: 5 to 15. Longer: 8 to 20 |
| `grounding` | Do answers come from the lecture, or did the model make things up? | For each answer, at least half its content words must appear in the lecture text |
| `no_duplicates` | Did it pad the deck with the same question twice? | Questions with 80% of the same words, or 90% the same text, count as duplicates |

Grounding by keyword overlap is crude. A correct paraphrase can fail it, and a confidently wrong answer that reuses lecture words can pass. That's fine for a first gate: it catches the big failures (hallucinated facts, the fake LLM's garbage) for free. The next step real teams take is **LLM-as-judge**: a second model call that reads the lecture and each card and grades it against a rubric. It's in Known gaps.

### The samples

`evals/samples/` has 8 short lectures I wrote (networks, biology, economics, algorithms, history, physics, psychology, databases), 190 to 450 words each, as `.txt` so they're easy to read and diff. The runner also accepts `.pdf`, using the worker's exact PDF extraction. **Add 2 to 5 of your own PDFs** to get to the 10 to 15 the plan calls for, ideally longer ones, since mine are all short. Only use material you have the right to put in a public repo: your own notes, or openly licensed textbooks like OpenStax (CC BY). Not your professors' slides.

```bash
ls evals/samples
```

### The code

`evals/scoring.py` (the checks, no LLM calls in here):

```bash
cat > evals/scoring.py <<'EOF'
"""Checks that score one study set against the lecture it came from.

Every check returns a number from 0.0 (bad) to 1.0 (good), so they can be averaged.
No LLM calls in here: these are cheap, deterministic checks (the "keyword overlap first"
part of the plan). An LLM-as-judge can be added later as one more check.
"""

import re
from difflib import SequenceMatcher

from pydantic import ValidationError

from worker.llm import StudySet

# Common words that say nothing about whether an answer came from the lecture
STOPWORDS = set(
    """a an and are as at be because been but by can do does for from has have how if in into
    is it its it's more most no not of on one or so such than that the their them then there
    these they this those to too two use used uses using was way we what when where which while
    who why will with would you your also each every other only very about after before both
    same than over under between""".split()
)


def words(text: str) -> list[str]:
    """Lowercase content words, with a crude plural strip so "cards" matches "card"."""
    found = re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower())
    return [w.removesuffix("s") if len(w) > 4 else w for w in found if w not in STOPWORDS]


def card_range(lecture_words: int) -> tuple[int, int]:
    """How many cards make sense for a lecture this long. Matches the prompt's 5 to 20."""
    if lecture_words < 300:
        return 5, 10
    if lecture_words < 1000:
        return 5, 15
    return 8, 20


def check_schema(raw: dict) -> float:
    """1.0 if the output parses as a StudySet with no empty fields."""
    try:
        study_set = StudySet.model_validate(raw)
    except ValidationError:
        return 0.0
    texts = [study_set.summary] + [t for c in study_set.cards for t in (c.question, c.answer)]
    return 1.0 if study_set.cards and all(t.strip() for t in texts) else 0.0


def check_card_count(study_set: StudySet, lecture: str) -> float:
    low, high = card_range(len(lecture.split()))
    return 1.0 if low <= len(study_set.cards) <= high else 0.0


def grounded(answer: str, lecture_words: set[str], min_overlap: float = 0.5) -> bool:
    """An answer is grounded if most of its content words appear in the lecture."""
    answer_words = words(answer)
    if not answer_words:
        return True  # "Yes." or "1789" has no content words to check
    found = sum(w in lecture_words for w in answer_words)
    return found / len(answer_words) >= min_overlap


def check_grounding(study_set: StudySet, lecture: str) -> float:
    """Share of cards whose answers come from the lecture text."""
    if not study_set.cards:
        return 0.0
    lecture_words = set(words(lecture))
    return sum(grounded(c.answer, lecture_words) for c in study_set.cards) / len(study_set.cards)


def near_duplicate(q1: str, q2: str) -> bool:
    w1, w2 = set(words(q1)), set(words(q2))
    jaccard = len(w1 & w2) / len(w1 | w2) if w1 | w2 else 1.0
    similar_text = SequenceMatcher(None, q1.lower(), q2.lower()).ratio()
    return jaccard >= 0.8 or similar_text >= 0.9


def check_duplicates(study_set: StudySet) -> float:
    """1.0 means no two questions are (nearly) the same."""
    questions = [c.question for c in study_set.cards]
    if not questions:
        return 0.0
    duplicates = {
        j
        for i in range(len(questions))
        for j in range(i + 1, len(questions))
        if near_duplicate(questions[i], questions[j])
    }
    return 1 - len(duplicates) / len(questions)


def score(raw: dict, lecture: str) -> dict[str, float]:
    """All checks for one sample. Everything is 0 if the output isn't even valid."""
    schema = check_schema(raw)
    if not schema:
        return {"schema": 0.0, "card_count": 0.0, "grounding": 0.0, "no_duplicates": 0.0}
    study_set = StudySet.model_validate(raw)
    return {
        "schema": schema,
        "card_count": check_card_count(study_set, lecture),
        "grounding": check_grounding(study_set, lecture),
        "no_duplicates": check_duplicates(study_set),
    }
EOF
```

`evals/run_evals.py` (runs every sample through the worker's real `generate_study_set`, 4 at a time, prints a table, writes every card to `evals/results/latest.json`, exits 1 below the threshold):

```bash
cat > evals/run_evals.py <<'EOF'
"""Run every lecture in evals/samples through the real prompt and model, and score the output.

Usage, from the repo root (needs ANTHROPIC_API_KEY, costs a few cents per run):
    python evals/run_evals.py
    python evals/run_evals.py --threshold 0.9
    FAKE_LLM=1 python evals/run_evals.py      (free, and should FAIL: fake cards are garbage)

Exit code 0 if the overall score is at or above the threshold, 1 if not. That exit code
is what makes this a quality gate in CI.
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Use the worker's real code (prompt, model settings, PDF extraction), not a copy of it
sys.path.insert(0, str(ROOT.parent / "apps" / "worker"))
# worker.tasks reads these when imported. Nothing here talks to a database or S3.
for name, value in {"DATABASE_URL": "unused", "S3_BUCKET": "unused"}.items():
    os.environ.setdefault(name, value)

from scoring import score  # noqa: E402
from worker.llm import MODEL, generate_study_set  # noqa: E402
from worker.tasks import extract_text  # noqa: E402

SAMPLES = ROOT / "samples"
RESULTS = ROOT / "results"
CHECKS = ["schema", "card_count", "grounding", "no_duplicates"]


def load_lecture(path: Path) -> str:
    if path.suffix == ".pdf":
        return extract_text(path.read_bytes())  # same extraction the worker does
    return path.read_text()


def run_sample(path: Path) -> dict:
    lecture = load_lecture(path)
    try:
        raw = generate_study_set(lecture).model_dump()
    except Exception as e:  # one broken sample shouldn't hide the others' results
        return {
            "sample": path.name,
            "error": f"{type(e).__name__}: {e}",
            "output": None,
            "scores": dict.fromkeys(CHECKS, 0.0),
        }
    return {"sample": path.name, "error": None, "output": raw, "scores": score(raw, lecture)}


def summary_table(results: list[dict], overall: float, threshold: float) -> str:
    lines = [
        "| Sample | Cards | " + " | ".join(CHECKS) + " |",
        "|---|---|" + "---|" * len(CHECKS),
    ]
    for r in results:
        cards = len(r["output"]["cards"]) if r["output"] else "error"
        cells = " | ".join(f"{r['scores'][c]:.2f}" for c in CHECKS)
        lines.append(f"| {r['sample']} | {cards} | {cells} |")
    verdict = "PASS" if overall >= threshold else "FAIL"
    lines.append("")
    lines.append(f"**Overall: {overall:.3f}** (threshold {threshold}): **{verdict}**")
    lines.append(f"Model `{MODEL}`, {len(results)} samples")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("EVAL_THRESHOLD", "0.85")),
        help="lowest overall score that passes (default 0.85)",
    )
    args = parser.parse_args()

    samples = sorted(p for p in SAMPLES.iterdir() if p.suffix in {".txt", ".pdf"})
    print(f"Running {len(samples)} samples through {MODEL}...", flush=True)
    # A few at a time: faster than one by one, gentler on rate limits than all at once
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run_sample, samples))

    per_sample = [sum(r["scores"].values()) / len(CHECKS) for r in results]
    overall = sum(per_sample) / len(per_sample)
    table = summary_table(results, overall, args.threshold)
    print(table)
    for r in results:
        if r["error"]:
            print(f"ERROR in {r['sample']}: {r['error']}")

    # Full outputs, so you can read the actual cards behind a bad score
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "latest.json").write_text(
        json.dumps(
            {"model": MODEL, "overall": overall, "threshold": args.threshold, "results": results},
            indent=2,
        )
    )
    # In GitHub Actions, the same table shows up on the run's summary page
    if summary_file := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary_file, "a") as f:
            f.write("## AI evals\n\n" + table + "\n")

    return 0 if overall >= args.threshold else 1


if __name__ == "__main__":
    sys.exit(main())
EOF
```

The `sys.path` line is how the eval reuses the worker's code instead of copying it: same prompt file, same model setting, same PDF extraction. If someone changes any of them, the eval tests the change.

Tests for the scoring itself. A quality gate with a bug in it is worse than no gate, because people trust it.

`evals/tests/test_scoring.py` (new folder):

```bash
mkdir -p evals/tests
```

```bash
cat > evals/tests/test_scoring.py <<'EOF'
from scoring import (
    card_range,
    check_card_count,
    check_duplicates,
    check_grounding,
    check_schema,
    score,
)
from worker.llm import Card, StudySet

LECTURE = (
    "TCP is connection oriented and uses a three-way handshake. "
    "UDP is connectionless and has an 8 byte header. "
    "DNS queries usually use UDP because one small request is faster without a handshake."
)


def cards(*pairs):
    return StudySet(summary="TCP and UDP.", cards=[Card(question=q, answer=a) for q, a in pairs])


def test_schema_rejects_missing_fields_and_empty_text():
    assert check_schema({"summary": "S", "cards": [{"question": "Q?", "answer": "A"}]}) == 1.0
    assert check_schema({"summary": "S"}) == 0.0
    assert check_schema({"summary": "S", "cards": []}) == 0.0
    assert check_schema({"summary": "S", "cards": [{"question": " ", "answer": "A"}]}) == 0.0


def test_card_range_grows_with_lecture_length():
    assert card_range(200) == (5, 10)
    assert card_range(600) == (5, 15)
    assert card_range(5000) == (8, 20)


def test_card_count():
    three = cards(*[(f"Q{i}?", "A") for i in range(3)])
    seven = cards(*[(f"Q{i}?", "A") for i in range(7)])
    assert check_card_count(three, LECTURE) == 0.0  # short lecture still needs 5
    assert check_card_count(seven, LECTURE) == 1.0


def test_grounding_catches_answers_not_in_the_lecture():
    study_set = cards(
        ("How does TCP start a connection?", "With a three-way handshake."),
        ("Why does DNS use UDP?", "One small request is faster without a handshake."),
        ("Who invented TCP?", "Vint Cerf and Bob Kahn at DARPA in 1974."),  # not in the lecture
        ("Is UDP connection oriented?", "No."),  # nothing to check, counts as grounded
    )
    assert check_grounding(study_set, LECTURE) == 0.75


def test_fake_llm_cards_are_not_grounded():
    fake = cards(*[(f"(fake) Question {i}?", f"(fake) Answer {i}") for i in range(1, 4)])
    assert check_grounding(fake, LECTURE) == 0.0


def test_duplicates():
    study_set = cards(
        ("What handshake does TCP use?", "Three-way."),
        ("What handshake does TCP use?", "Three-way handshake."),  # exact repeat
        ("Which handshake is used by TCP?", "Three-way."),  # same words, new order
        ("How big is the UDP header?", "8 bytes."),
    )
    assert check_duplicates(study_set) == 0.5


def test_invalid_output_scores_zero_everywhere():
    assert set(score({"oops": True}, LECTURE).values()) == {0.0}
EOF
```

Supporting files:

```bash
cat > evals/requirements.txt <<'EOF'
# The evals import the worker's code, so they need the worker's packages
-r ../apps/worker/requirements.txt
pytest==9.1.1
EOF
cat > evals/pytest.ini <<'EOF'
[pytest]
# Lets tests "import scoring" and "from worker.llm import ..."
pythonpath = . ../apps/worker
testpaths = tests
EOF
```

`ruff` needs to know `scoring` is our own code (for import sorting), and the eval results shouldn't go in Git (they're regenerated every run, and large):

```bash
sed -i '' 's|^src = \["apps/api", "apps/worker"\]|src = ["apps/api", "apps/worker", "evals"]|' ruff.toml
grep '^src' ruff.toml
printf '\n# Eval outputs (full model responses), regenerated on every run\nevals/results/\n' >> .gitignore
tail -3 .gitignore
```

Now all the local checks, including the new eval scoring tests:

```bash
bash scripts/ci-local.sh
```

Ends with `All local checks passed`, with `7 passed` in the evals block.

## Step 5: Run the evals locally

Same trick as `ci-local.sh`: run it inside `python:3.12-slim`, so it's the same Python as CI and your Mac's Python doesn't matter. A small wrapper:

`scripts/run-evals.sh`:

```bash
cat > scripts/run-evals.sh <<'EOF'
#!/usr/bin/env bash
# Runs the AI evals inside python:3.12-slim (same Python as CI), so your Mac's Python doesn't matter.
# Usage, from the repo root:
#   bash scripts/run-evals.sh                    real model, needs ANTHROPIC_API_KEY exported
#   FAKE_LLM=1 bash scripts/run-evals.sh         free, and should FAIL
#   bash scripts/run-evals.sh --threshold 0.9    extra args go to evals/run_evals.py
# Exits with run_evals.py's exit code: 0 pass, 1 fail.
set -euo pipefail
cd "$(dirname "$0")/.."

# -e NAME with no value passes the variable through only if it's set here
docker run --rm -v "$PWD":/repo -w /repo \
  -e ANTHROPIC_API_KEY -e FAKE_LLM -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
  python:3.12-slim \
  sh -c 'pip install -q --root-user-action=ignore -r evals/requirements.txt && python evals/run_evals.py "$@"' \
  sh "$@"
EOF
```

The `sh "$@"` at the end passes your arguments (like `--threshold 0.9`) through to `run_evals.py`, and the script exits with the eval's exit code.

### 5a. Prove the gate can fail (free)

A gate that has never failed hasn't been tested. Run it against the fake LLM, which returns three `(fake) Question 1?` cards for every lecture:

```bash
FAKE_LLM=1 bash scripts/run-evals.sh
echo "exit code: $?"
```

Every sample gets `grounding 0.00` (fake answers aren't in any lecture), `card_count 0.00` (3 is below 5), and `no_duplicates 0.33` (the questions are nearly identical). Overall about **0.33, FAIL, exit code 1**. That `1` is what will fail CI.

### 5b. The real baseline (a few cents)

Load the key from `.env` into this terminal only, without printing it:

```bash
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' .env | cut -d= -f2-)"
bash scripts/run-evals.sh
```

It takes a minute or two. Look at the table:
- `schema` should be 1.00 everywhere (the SDK forces the JSON shape).
- `card_count` 1.00 unless the model wrote more than 10 cards for one of the very short lectures.
- `grounding` somewhere around 0.8 to 1.0. Anything lower: open `evals/results/latest.json`, find that sample, and read the answers. Is the model adding outside knowledge, or is my overlap check too strict for a paraphrase? Deciding which is the real skill here.
- `no_duplicates` should be 1.00.

What did it cost? The Anthropic Console > **Usage** shows it (it can lag a few minutes). Write it down: that's your per-PR eval cost. (Inside the cluster, the worker's new metrics count tokens and dollars for you.)

Run it **two more times** and write down the three overall scores. They'll differ a little: that's the non-determinism. **Set the threshold about 0.05 below your lowest run**, so normal wobble passes and a real drop fails. If your runs were 0.94, 0.92, 0.95, use 0.87. Change the default in `run_evals.py`:

```bash
grep -n '"0.85"' evals/run_evals.py
```

Edit that line (and the `default 0.85` in the help text below it) to your number. This is a judgment call real teams make the same way: baseline first, then a threshold with margin, revisited when the eval set changes.

### 5c. Break the prompt on purpose

Make the prompt ask for something the gate should catch:

```bash
sed -i '' 's/^2\. Write .*/2. Write exactly 30 flashcards, and include interesting related facts that are not in the lecture./' apps/worker/worker/prompts/flashcards_v1.txt
git diff apps/worker/worker/prompts/
bash scripts/run-evals.sh
echo "exit code: $?"
```

`card_count` should drop to 0 everywhere and grounding should fall. **FAIL, exit 1.** Put the prompt back:

```bash
git checkout apps/worker/worker/prompts/flashcards_v1.txt
git diff apps/worker/worker/prompts/
```

The second command prints nothing. That's the whole value of the gate in one exercise: a plausible-looking prompt change that would have shipped quietly now can't.

## Step 6: Evals in CI

Two new jobs in `ci.yml`:

- **Detect changes** runs on PRs only. It diffs the PR against its base and sets `evals=true` if anything under `apps/worker/`, `evals/` or `ci.yml` itself changed. The prompt lives in `apps/worker/worker/prompts/`, so prompt edits count. (The popular way to do this is the `dorny/paths-filter` action. Five lines of `git diff` do the same without giving another third-party action access to the repo.)
- **AI evals** runs only when that output is `true`: installs, runs the scoring unit tests, then the real evals with the `ANTHROPIC_API_KEY` secret. The score table lands on the run's **Summary** page, and every card is uploaded as an artifact for when a score drops.

And **CI passed** now lists `evals` in its `needs`. A *skipped* eval (PR didn't touch the worker) doesn't fail it; a *failed* one does. That's what turns a score into a merge blocker without making every docs PR pay for LLM calls.

Why not GitHub's built-in `on: pull_request: paths:` filter on a separate workflow? Because a required check from a workflow that *didn't run* stays "Expected" forever and blocks the merge. Skipping a *job* inside a workflow that always runs avoids that. This exact trap bites a lot of teams.

`.github/workflows/ci.yml`:

```bash
cat > .github/workflows/ci.yml <<'EOF'
name: CI

on:
  pull_request:
  push:
    branches: [main]

# Least privilege: this workflow only needs to read the code
permissions:
  contents: read

# A new push to a PR cancels the old, now useless run of that PR
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  lint-python:
    name: Lint (ruff)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: requirements-dev.txt
      - run: pip install -r requirements-dev.txt
      - run: ruff check --output-format=github .
      - run: ruff format --check .

  lint-web:
    name: Lint (eslint)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/web
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: apps/web/package-lock.json
      - run: npm ci
      - run: npm run lint

  lint-helm:
    name: Lint (helm)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: helm version
      - name: Lint the chart with each environment's values
        run: |
          helm lint --strict deploy/helm/flashcards
          helm lint --strict deploy/helm/flashcards -f deploy/helm/flashcards/values-staging.yaml
          helm lint --strict deploy/helm/flashcards -f deploy/helm/flashcards/values-prod.yaml

  lint-terraform:
    name: Lint (terraform)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1
        with:
          terraform_version: 1.16.7
          # Plain terraform output, no wrapper script around it
          terraform_wrapper: false
      - name: Formatting
        run: terraform fmt -check -recursive -diff infra/terraform
      - name: Validate each root (no AWS credentials needed)
        run: |
          for root in bootstrap global envs/staging envs/prod; do
            echo "== $root"
            terraform -chdir="infra/terraform/$root" init -backend=false -input=false
            terraform -chdir="infra/terraform/$root" validate
          done

  test:
    name: Test (${{ matrix.app }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        app: [api, worker]
    defaults:
      run:
        working-directory: apps/${{ matrix.app }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: apps/${{ matrix.app }}/requirements*.txt
      - run: pip install -r requirements-dev.txt
      - run: pytest -v

  build-and-scan:
    name: Build + scan (${{ matrix.app }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        app: [web, api, worker]
    steps:
      - uses: actions/checkout@v7

      # Third-party actions are pinned to a full commit SHA, not a tag (tags can be moved)
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1

      - name: Build image
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: apps/${{ matrix.app }}
          load: true
          push: false
          tags: flashcards-${{ matrix.app }}:${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.app }}
          cache-to: type=gha,mode=max,scope=${{ matrix.app }}

      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: flashcards-${{ matrix.app }}:${{ github.sha }}
          severity: CRITICAL
          ignore-unfixed: true
          exit-code: "1"
          format: table

  # Decides which optional jobs this PR needs, from the files it changes
  changes:
    name: Detect changes
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    outputs:
      evals: ${{ steps.filter.outputs.evals }}
    steps:
      - uses: actions/checkout@v7
        with:
          # Full history, so the PR's base commit is here to diff against
          fetch-depth: 0
      - id: filter
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
        run: |
          git diff --name-only "$BASE" HEAD | tee changed.txt
          # The AI's output can only change if the prompt, the worker's code or its
          # packages, or the evals themselves change
          if grep -qE '^(apps/worker/|evals/|\.github/workflows/ci\.yml$)' changed.txt; then
            echo "evals=true" >> "$GITHUB_OUTPUT"
          else
            echo "evals=false" >> "$GITHUB_OUTPUT"
          fi

  # Real LLM calls on sample lectures, scored. Costs a few cents, so only when needed.
  evals:
    name: AI evals
    needs: changes
    if: needs.changes.outputs.evals == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: |
            evals/requirements.txt
            apps/worker/requirements.txt
      - run: pip install -r evals/requirements.txt
      - name: Unit tests for the scoring code
        working-directory: evals
        run: pytest -v
      - name: Run evals
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::error::ANTHROPIC_API_KEY secret is missing (Dependabot PRs need it under Dependabot secrets too)"
            exit 1
          fi
          python evals/run_evals.py
      # Every card the model wrote, downloadable from the run page, for when a score drops
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: eval-results
          path: evals/results/latest.json
          if-no-files-found: ignore

  # Optional deeper analysis. Not in ci-passed, so a SonarCloud outage can't block merges
  sonarcloud:
    name: SonarCloud
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: SonarSource/sonarqube-scan-action@d209202bc7d53ff1cc128f7f907dac145c9d6ae9 # v8.3.0
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

  # One stable check name for branch protection, no matter how the matrix changes
  ci-passed:
    name: CI passed
    if: always()
    # A skipped job (evals on a PR that didn't touch the worker) is fine, a failed one is not
    needs: [lint-python, lint-web, lint-helm, lint-terraform, test, build-and-scan, evals]
    runs-on: ubuntu-latest
    steps:
      - name: Fail if any job failed or was cancelled
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
      - run: echo "All CI jobs passed"
EOF
```

### 6a. A CI-only API key with a spend limit

1. [console.anthropic.com](https://console.anthropic.com) > **Settings** > **Workspaces** > **Create workspace**, name it `flashcards-ci`.
2. In that workspace, set a **spend limit** (Limits): $5 a month is plenty.
3. **API keys** > **Create key** in the `flashcards-ci` workspace, name it `github-actions`. Copy it.
4. Store it in GitHub. This prompts for the value, so it never lands in your shell history:
   ```bash
   gh secret set ANTHROPIC_API_KEY
   ```
5. Dependabot PRs can't read normal Actions secrets (so a malicious dependency can't steal them). A Dependabot bump of the `anthropic` package *should* run the evals, so give Dependabot its own copy:
   ```bash
   gh secret set ANTHROPIC_API_KEY --app dependabot
   ```
6. Check both exist (names only, values are never shown):
   ```bash
   gh secret list
   gh secret list --app dependabot
   ```

## Step 7: Chart changes

### 7a. Probes, metrics port, and who owns the replica count

`templates/api.yaml` gets the `startupProbe` from Step 1, loses `initialDelaySeconds` on liveness (the startup probe replaces that guess), and stops setting `replicas` when the HPA is on.

`deploy/helm/flashcards/templates/api.yaml`:

```bash
cat > deploy/helm/flashcards/templates/api.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  {{- /* With an autoscaler, the HPA owns the replica count. Setting it here too would make every deploy reset it. */}}
  {{- if not .Values.autoscaling.api.enabled }}
  replicas: {{ .Values.api.replicas }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "flashcards.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: api
  template:
    metadata:
      labels:
        {{- include "flashcards.labels" . | nindent 8 }}
        app.kubernetes.io/component: api
      annotations:
        {{- include "flashcards.configChecksum" . | nindent 8 }}
    spec:
      enableServiceLinks: false
      containers:
        - name: api
          image: {{ include "flashcards.image" (list . "api") }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8000
          envFrom:
            - configMapRef:
                name: flashcards-config
          env:
            {{- include "flashcards.secretEnv" (list .Values.existingSecret .Values.secretKeys.api) | trim | nindent 12 }}
          # Startup can take minutes if the database isn't reachable yet (main.py retries it).
          # Liveness and readiness only begin once this passes, so a slow start isn't a crash.
          startupProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 5
            failureThreshold: 36  # 36 x 5s = 3 minutes, longer than DB_WAIT_SECONDS
          readinessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
            failureThreshold: 3
          resources:
            {{- toYaml .Values.api.resources | nindent 12 }}
          securityContext:
            {{- include "flashcards.pythonSecurityContext" . | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: api
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  selector:
    {{- include "flashcards.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: api
  ports:
    - name: http
      port: 8000
      targetPort: http
EOF
```

**Why drop `replicas` when autoscaling?** The HPA (or KEDA) changes the Deployment's replica count at runtime. If the chart also says `replicas: 1`, every `helm upgrade` or Argo CD sync resets it to 1, then the autoscaler scales back up, over and over. Rule: exactly one owner per field. (The first upgrade after this change briefly sets the worker to 1 pod as the field is removed; then KEDA takes over.)

`templates/worker.yaml` gets the same `replicas` rule and names port 9100 `metrics` so a PodMonitor can find it:

```bash
cat > deploy/helm/flashcards/templates/worker.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: worker
spec:
  {{- /* With KEDA, the ScaledObject owns the replica count (including zero) */}}
  {{- if not .Values.autoscaling.worker.enabled }}
  replicas: {{ .Values.worker.replicas }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "flashcards.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: worker
  template:
    metadata:
      labels:
        {{- include "flashcards.labels" . | nindent 8 }}
        app.kubernetes.io/component: worker
      annotations:
        {{- include "flashcards.configChecksum" . | nindent 8 }}
    spec:
      enableServiceLinks: false
      terminationGracePeriodSeconds: {{ .Values.worker.terminationGracePeriodSeconds }}
      containers:
        - name: worker
          image: {{ include "flashcards.image" (list . "worker") }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: metrics
              containerPort: 9100
          envFrom:
            - configMapRef:
                name: flashcards-config
          env:
            {{- include "flashcards.secretEnv" (list .Values.existingSecret .Values.secretKeys.worker) | trim | nindent 12 }}
          resources:
            {{- toYaml .Values.worker.resources | nindent 12 }}
          securityContext:
            {{- include "flashcards.pythonSecurityContext" . | nindent 12 }}
EOF
```

### 7b. Sync waves for External Secrets

Two annotations in `templates/external-secrets.yaml`. They do nothing on kind (no Argo CD there, and External Secrets is off), and in the cloud they make Argo CD wait for the Secret before starting the apps. Argo CD has a built-in health check for `ExternalSecret`: healthy means the Secret was built.

```bash
cat > deploy/helm/flashcards/templates/external-secrets.yaml <<'EOF'
{{- if .Values.externalSecrets.enabled }}
# Where External Secrets reads from: AWS Secrets Manager. No credentials here on purpose.
# The controller uses the VM's IAM role, which may only read this environment's secrets.
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
  annotations:
    # Argo CD applies wave -1 first and waits for it to be healthy before wave 0 (the apps)
    argocd.argoproj.io/sync-wave: "-1"
spec:
  provider:
    aws:
      service: SecretsManager
      region: {{ .Values.externalSecrets.region }}
---
# Builds the same Secret you made by hand in Phase 3 (existingSecret), from two
# Secrets Manager entries. The api and worker templates don't know the difference.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: {{ .Values.existingSecret }}
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
  annotations:
    # Healthy = the Secret was built. Only then does Argo CD start the api and worker.
    argocd.argoproj.io/sync-wave: "-1"
spec:
  # How often to re-read Secrets Manager. A changed value lands in the Secret within this time.
  refreshInterval: 1h
  secretStoreRef:
    kind: SecretStore
    name: aws-secrets-manager
  target:
    name: {{ .Values.existingSecret }}
    # The ExternalSecret owns the Secret: delete one and the other goes too
    creationPolicy: Owner
    template:
      engineVersion: v2
      # The inner double-brace parts are External Secrets templates, not Helm ones. The backticks make
      # Helm pass them through untouched.
      data:
        DATABASE_URL: {{ `postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .dbname }}?sslmode=require` | quote }}
        ANTHROPIC_API_KEY: {{ `{{ .anthropicApiKey }}` | quote }}
  # The JSON written by Terraform (username, password, host, port, dbname), one key per field
  dataFrom:
    - extract:
        key: {{ required "externalSecrets.prefix is required" .Values.externalSecrets.prefix }}/db
  # The plain-text API key you put in with the AWS CLI
  data:
    - secretKey: anthropicApiKey
      remoteRef:
        key: {{ .Values.externalSecrets.prefix }}/anthropic-api-key
{{- end }}
EOF
```

### 7c. Autoscalers

`deploy/helm/flashcards/templates/autoscaling.yaml`:

```bash
cat > deploy/helm/flashcards/templates/autoscaling.yaml <<'EOF'
{{- if .Values.autoscaling.api.enabled }}
# API: add pods when average CPU goes above the target. Plain Kubernetes, reads metrics-server.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: {{ .Values.autoscaling.api.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.api.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.api.targetCPUUtilizationPercentage }}
{{- end }}
{{- if .Values.autoscaling.worker.enabled }}
---
# Worker: scale on the queue, not on CPU. A worker waiting on the LLM uses almost no CPU,
# so CPU would never say "we're behind". KEDA reads the queue length straight from Redis
# and creates (and drives) an HPA for the worker Deployment.
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: worker
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: {{ .Values.autoscaling.worker.minReplicas }}
  maxReplicaCount: {{ .Values.autoscaling.worker.maxReplicas }}
  # How often KEDA checks the queue, in seconds
  pollingInterval: 5
  cooldownPeriod: {{ .Values.autoscaling.worker.cooldownSeconds }}
  triggers:
    - type: redis
      metadata:
        # KEDA runs in its own namespace, so it needs the full service name
        address: redis.{{ .Release.Namespace }}.svc.cluster.local:6379
        # RQ keeps waiting job IDs in a Redis list with this name
        listName: rq:queue:jobs
        listLength: {{ .Values.autoscaling.worker.jobsPerWorker | quote }}
        # Wake up from zero as soon as one job is waiting
        activationListLength: "0"
{{- end }}
EOF
```

**HPA vs KEDA, the interview version.** The HPA is built into Kubernetes and scales on CPU or memory (or custom metrics if you add an adapter). That's right for the api: more requests, more CPU, more pods. It's wrong for the worker: a worker waiting 30 seconds for the LLM uses almost no CPU, so the HPA would happily leave 200 jobs waiting. KEDA scales on **the thing you actually care about**, here the length of the Redis list RQ keeps waiting job IDs in (`rq:queue:jobs`), and it can go to **zero** pods, which a plain HPA can't. Under the hood KEDA creates an HPA too (you'll see `keda-hpa-worker` in Step 11b); KEDA just feeds it the queue length and handles 0 to 1.

`listLength: "2"` means "aim for 2 waiting jobs per worker": 10 waiting jobs asks for 5 workers. `cooldownPeriod` is how long the queue must stay empty before going from 1 worker to 0.

**The trap with scale-down: killing a worker mid-job.** When the queue empties, KEDA scales down, and Kubernetes picks a pod to stop, maybe one that's 4 minutes into an LLM call. What happens next:
1. Kubernetes sends SIGTERM.
2. RQ catches it and does a warm shutdown: no new jobs, finish the current one, exit.
3. Kubernetes waits up to `terminationGracePeriodSeconds`, then SIGKILLs.

So the grace period must be longer than the longest job. The api enqueues with `job_timeout=600`, so the worker gets **630 seconds** (it was 120). That's in `values.yaml` below. It's the same reason companies give queue consumers long grace periods: scale-down must never lose work.

### 7d. Monitoring objects

`deploy/helm/flashcards/templates/monitoring.yaml`:

```bash
cat > deploy/helm/flashcards/templates/monitoring.yaml <<'EOF'
{{- if .Values.monitoring.enabled }}
# Tells Prometheus (through the Prometheus Operator) which pods to scrape.
# PodMonitor instead of ServiceMonitor because the worker has no Service.
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: api
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
spec:
  selector:
    matchLabels:
      {{- include "flashcards.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: api
  podMetricsEndpoints:
    - port: http
      path: /metrics
      interval: 15s
---
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: worker
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
spec:
  selector:
    matchLabels:
      {{- include "flashcards.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: worker
  podMetricsEndpoints:
    - port: metrics
      path: /metrics
      interval: 15s
---
# Alert rules. Prometheus evaluates them; firing alerts go to Alertmanager.
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: flashcards
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
spec:
  groups:
    - name: flashcards
      rules:
        - alert: FlashcardsJobFailureRateHigh
          # Failed jobs as a share of all finished jobs, over the last 15 minutes
          expr: |
            sum by (namespace) (increase(flashcards_jobs_total{status="failed"}[15m]))
              /
            sum by (namespace) (increase(flashcards_jobs_total[15m]))
              > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "More than 5% of flashcard jobs are failing in {{`{{ $labels.namespace }}`}}"
            description: "{{`{{ $value | humanizePercentage }}`}} of jobs failed in the last 15 minutes. Check the worker logs in Grafana."
        - alert: FlashcardsQueueBackedUp
          # The job at the front of the line has waited 10+ minutes for a worker
          expr: max by (namespace) (flashcards_queue_oldest_job_age_seconds) > 600
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Flashcard jobs have been waiting over 10 minutes in {{`{{ $labels.namespace }}`}}"
            description: "Oldest job has waited {{`{{ $value | humanizeDuration }}`}}. Are workers running? Check KEDA and the worker pods."
---
# The Grafana dashboard. Grafana's sidecar loads any ConfigMap with this label.
apiVersion: v1
kind: ConfigMap
metadata:
  name: flashcards-dashboard
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    grafana_dashboard: "1"
data:
  flashcards.json: |-
    {{- .Files.Get "files/dashboard.json" | nindent 4 }}
{{- end }}
EOF
```

- **PodMonitor**, not ServiceMonitor, because the worker has no Service. The Prometheus Operator turns these into scrape config, so nobody edits `prometheus.yml` by hand.
- **The two alerts from the plan.** Failure rate uses `increase(...[15m])` ratios and must stay above 5% for 5 minutes, so one bad PDF doesn't page anyone. "Queue backed up" uses the oldest job's age, which is more precise than "queue not empty for 10 minutes" (a busy but healthy queue is never empty). The backticks around `{{ $labels.namespace }}` tell Helm to leave those braces alone for Prometheus.
- **The dashboard** is a ConfigMap with the label `grafana_dashboard: "1"`. Grafana's sidecar watches for that label in every namespace and loads it. The JSON (`files/dashboard.json`, already in your folder) was built the normal way: panels designed in Grafana's UI, then **Export > JSON** and committed, so it's versioned and reviewable like code. Open it and skim: each panel is a title, a PromQL `expr`, and a position.

### 7e. Values

`deploy/helm/flashcards/values.yaml` (your local kind defaults: everything on):

```bash
cat > deploy/helm/flashcards/values.yaml <<'EOF'
# Default values: set up for the local kind cluster.
# values-staging.yaml and values-prod.yaml only override what is different.

image:
  # Empty = local images loaded with "kind load". In week 5 this becomes ghcr.io/<you>.
  registry: ""
  # Always a commit SHA in real deploys. Pass it with --set image.tag=...
  tag: dev
  # IfNotPresent: use the image already on the node. Locally there is nowhere to pull from.
  pullPolicy: IfNotPresent

# Name of a Secret that already exists in the namespace. The chart reads it but never creates it,
# so no secret value ever lives in Git. Keys: DATABASE_URL, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, ANTHROPIC_API_KEY.
existingSecret: flashcards-secrets

# Non-secret settings, shared by api and worker through a ConfigMap
config:
  REDIS_URL: redis://redis:6379/0
  S3_ENDPOINT: http://s3:8333
  S3_BUCKET: uploads
  AWS_DEFAULT_REGION: us-east-1
  LLM_MODEL: claude-opus-5-5
  FAKE_LLM: "1"

web:
  replicas: 1
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      memory: 64Mi

api:
  # Ignored while autoscaling.api is on
  replicas: 1
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      memory: 256Mi

worker:
  # Ignored while autoscaling.worker is on
  replicas: 1
  # Time a worker gets to finish its current job when Kubernetes stops it (deploys, scale down).
  # Longer than the API's job_timeout (600s), so no job is ever killed halfway.
  terminationGracePeriodSeconds: 630
  resources:
    requests:
      cpu: 50m
      memory: 192Mi
    limits:
      memory: 512Mi

ingress:
  enabled: true
  # k3s (week 6) also ships Traefik, so the same class name works there
  className: traefik
  # Empty = answer on any hostname (fine on localhost). Staging and prod set a real one.
  host: ""

# Post-deploy smoke test: a Job that uploads files/smoke.pdf and checks cards come back.
# Off by default. values-staging.yaml turns it on so a bad deploy shows up as a failed sync.
smokeTest:
  enabled: false
  # curl image, pinned by digest like the kind node image
  image: curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777

autoscaling:
  # Horizontal Pod Autoscaler on CPU. Needs metrics-server in the cluster.
  api:
    enabled: true
    minReplicas: 1
    maxReplicas: 3
    # Percent of the api's CPU request (50m), averaged over all api pods
    targetCPUUtilizationPercentage: 70
  # KEDA scales workers on the number of jobs waiting in Redis, down to zero when idle.
  # Needs KEDA in the cluster.
  worker:
    enabled: true
    minReplicas: 0
    maxReplicas: 5
    # Aim for this many waiting jobs per worker: 6 waiting jobs = 3 workers
    jobsPerWorker: 2
    # Seconds with an empty queue before going from 1 worker to 0
    cooldownSeconds: 300

# PodMonitors, alert rules and a Grafana dashboard for kube-prometheus-stack.
# Needs the Prometheus Operator's CRDs in the cluster.
monitoring:
  enabled: true

# Which keys of existingSecret each app reads. Only the worker gets the Anthropic key.
# In the cloud the AWS keys go away: pods use the VM's IAM role instead (see values-staging.yaml).
secretKeys:
  api: [DATABASE_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
  worker: [DATABASE_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ANTHROPIC_API_KEY]

# Make existingSecret from AWS Secrets Manager with External Secrets. Cloud only.
externalSecrets:
  enabled: false
  region: us-east-1
  # Secret names in Secrets Manager start with this, like flashcards/staging
  prefix: ""

# Redis (the job queue) as part of the chart. Cloud only: locally, dev-deps.yaml runs it.
redis:
  enabled: false
  image: redis:7

# HTTPS with a free Let's Encrypt certificate, requested by cert-manager. Needs ingress.host.
tls:
  enabled: false
  acmeServer: https://acme-v02.api.letsencrypt.org/directory
EOF
```

Staging and prod turn it all off for now (their clusters don't have the operators). This appends, so your image tags stay as they are:

```bash
for env in staging prod; do
  cat >> "deploy/helm/flashcards/values-$env.yaml" <<'EOF'

# Phase 6 runs monitoring and autoscaling on kind only so far: the cloud clusters don't
# have kube-prometheus-stack, metrics-server or KEDA installed yet (see the Phase 6 guide)
monitoring:
  enabled: false
autoscaling:
  api:
    enabled: false
  worker:
    enabled: false
EOF
done
git diff deploy/helm/flashcards/values-staging.yaml deploy/helm/flashcards/values-prod.yaml
```

Bump the chart version, since the chart's templates changed (version is the chart's own version, `appVersion` is the app's):

```bash
sed -i '' 's/^version: 0.1.0/version: 0.2.0/' deploy/helm/flashcards/Chart.yaml
grep '^version' deploy/helm/flashcards/Chart.yaml
```

Lint all three, exactly like CI:

```bash
helm lint --strict deploy/helm/flashcards
helm lint --strict deploy/helm/flashcards -f deploy/helm/flashcards/values-staging.yaml
helm lint --strict deploy/helm/flashcards -f deploy/helm/flashcards/values-prod.yaml
```

And see that staging only changed where you expect. This should show the startup probe, the grace period, the metrics port, the two sync-wave annotations and the chart version label, and **no** HPA, ScaledObject or PodMonitor:

```bash
rm -rf /tmp/chart-main && mkdir -p /tmp/chart-main
git archive main deploy/helm/flashcards | tar -x -C /tmp/chart-main
helm template t /tmp/chart-main/deploy/helm/flashcards -f /tmp/chart-main/deploy/helm/flashcards/values-staging.yaml > /tmp/before.yaml
helm template t deploy/helm/flashcards -f deploy/helm/flashcards/values-staging.yaml > /tmp/after.yaml
diff /tmp/before.yaml /tmp/after.yaml
```

(`git archive main` exports the chart exactly as it is on `main`, without touching your working folder.) Every object's `helm.sh/chart` label changes to `flashcards-0.2.0`; ignore those.

Reading the rendered diff before deploying is the Helm version of reading `terraform plan`.

## Step 8: Install the monitoring stack on kind

The values files for the three charts. They're local only (`deploy/local/`), sized for a laptop.

```bash
mkdir -p deploy/local/monitoring
```

`deploy/local/monitoring/kube-prometheus-stack-values.yaml`:

```bash
cat > deploy/local/monitoring/kube-prometheus-stack-values.yaml <<'EOF'
# kube-prometheus-stack on the LOCAL kind cluster: Prometheus, Alertmanager, Grafana,
# kube-state-metrics, node-exporter and the Prometheus Operator, sized for a laptop.
# Install (Step 9 of the Phase 6 guide):
#   helm install monitoring prometheus-community/kube-prometheus-stack --version 92.17.0 \
#     -n monitoring --create-namespace -f deploy/local/monitoring/kube-prometheus-stack-values.yaml

prometheus:
  prometheusSpec:
    # By default the operator only picks up PodMonitors, ServiceMonitors and rules that carry
    # this Helm release's label. false = pick up every one in the cluster, like our chart's.
    podMonitorSelectorNilUsesHelmValues: false
    serviceMonitorSelectorNilUsesHelmValues: false
    ruleSelectorNilUsesHelmValues: false
    # Laptop settings: two days of data, small disk use
    retention: 2d
    retentionSize: 2GB
    scrapeInterval: 15s
    resources:
      requests:
        cpu: 100m
        memory: 400Mi
      limits:
        memory: 1Gi

alertmanager:
  alertmanagerSpec:
    resources:
      requests:
        cpu: 10m
        memory: 32Mi
      limits:
        memory: 128Mi

grafana:
  # The chart generates a random admin password and keeps it in a Secret (Step 9 shows how to read it)
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      memory: 384Mi
  # Loki (installed next) as a second data source, so logs and metrics sit side by side
  additionalDataSources:
    - name: Loki
      type: loki
      uid: loki
      url: http://loki.monitoring.svc.cluster.local:3100
      access: proxy

# kind runs these control plane parts in a way Prometheus can't scrape. Turning them off
# avoids four permanently red targets.
kubeControllerManager:
  enabled: false
kubeScheduler:
  enabled: false
kubeEtcd:
  enabled: false
kubeProxy:
  enabled: false
# node-exporter reports the machine's CPU, memory and disk. On kind the "machine" is a
# container inside Docker Desktop's VM, so the numbers aren't very meaningful, and on a
# laptop the memory is better spent elsewhere. Keep it on in any real cluster.
nodeExporter:
  enabled: false
EOF
```

The `NilUsesHelmValues: false` lines are the #1 kube-prometheus-stack gotcha: by default Prometheus ignores every PodMonitor and rule that wasn't installed by its own Helm release, so your app's monitors would silently never be scraped.

`deploy/local/monitoring/loki-values.yaml`:

```bash
cat > deploy/local/monitoring/loki-values.yaml <<'EOF'
# Loki on the LOCAL kind cluster: one pod ("single binary"), logs on a small local disk.
# Production Loki splits into many components and keeps logs in S3 (see Known gaps).
# Install (Step 10 of the Phase 6 guide):
#   helm install loki grafana/loki --version 7.5.0 -n monitoring -f deploy/local/monitoring/loki-values.yaml

deploymentMode: SingleBinary

loki:
  # One tenant, no login between Alloy, Grafana and Loki (fine inside one cluster)
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: filesystem
  schemaConfig:
    configs:
      - from: "2024-04-01"
        store: tsdb
        object_store: filesystem
        schema: v13
        index:
          prefix: loki_index_
          period: 24h
  # Delete logs older than 3 days
  limits_config:
    retention_period: 72h
  compactor:
    retention_enabled: true
    delete_request_store: filesystem

singleBinary:
  replicas: 1
  persistence:
    size: 2Gi
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      memory: 512Mi

# The scalable-mode components, off
read:
  replicas: 0
write:
  replicas: 0
backend:
  replicas: 0

# Memcached caches. On by default and they ask for gigabytes of memory, so off on a laptop.
chunksCache:
  enabled: false
resultsCache:
  enabled: false

# Extras we don't need locally
gateway:
  enabled: false
lokiCanary:
  enabled: false
test:
  enabled: false
EOF
```

`deploy/local/monitoring/alloy-values.yaml`:

```bash
cat > deploy/local/monitoring/alloy-values.yaml <<'EOF'
# Grafana Alloy: reads every pod's logs through the Kubernetes API and ships them to Loki.
# (Alloy replaces Promtail, which Grafana has deprecated.)
# Install (Step 10 of the Phase 6 guide):
#   helm install alloy grafana/alloy --version 1.15.0 -n monitoring -f deploy/local/monitoring/alloy-values.yaml

controller:
  # One pod is enough: it reads logs through the API server, not from the node's disk.
  # More than one would ship every line twice (unless you turn on Alloy clustering).
  type: deployment
  replicas: 1

alloy:
  resources:
    requests:
      cpu: 20m
      memory: 64Mi
    limits:
      memory: 256Mi
  configMap:
    content: |
      // Find every pod in the cluster
      discovery.kubernetes "pods" {
        role = "pod"
      }

      // Turn Kubernetes metadata into Loki labels you can filter on in Grafana
      discovery.relabel "pods" {
        targets = discovery.kubernetes.pods.targets
        rule {
          source_labels = ["__meta_kubernetes_namespace"]
          target_label  = "namespace"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_name"]
          target_label  = "pod"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_container_name"]
          target_label  = "container"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_component"]
          target_label  = "component"
        }
      }

      // Tail each container's logs through the Kubernetes API
      loki.source.kubernetes "pods" {
        targets    = discovery.relabel.pods.output
        forward_to = [loki.write.default.receiver]
      }

      loki.write "default" {
        endpoint {
          url = "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"
        }
      }
EOF
```

Alloy's config language looks like Terraform on purpose: blocks are components, and `forward_to` wires one component's output into the next. Read it top to bottom: find pods, turn their metadata into labels, tail their logs, send to Loki.

Install, one at a time, checking each. Prometheus and friends first (pulls several images, give it a few minutes):

```bash
helm install monitoring prometheus-community/kube-prometheus-stack --version 92.17.0 \
  -n monitoring --create-namespace \
  -f deploy/local/monitoring/kube-prometheus-stack-values.yaml \
  --wait --timeout 10m
kubectl get pods -n monitoring
```

Five pods `Running`: the operator, Prometheus, Alertmanager, Grafana (3 containers: Grafana plus two sidecars that load dashboards and data sources) and kube-state-metrics (turns Kubernetes objects into metrics, like "how many worker replicas"). Then Loki:

```bash
helm install loki grafana/loki --version 7.5.0 -n monitoring \
  -f deploy/local/monitoring/loki-values.yaml --wait --timeout 5m
kubectl get pods -n monitoring -l app.kubernetes.io/name=loki
```

Then Alloy:

```bash
helm install alloy grafana/alloy --version 1.15.0 -n monitoring \
  -f deploy/local/monitoring/alloy-values.yaml --wait --timeout 5m
kubectl logs -n monitoring deploy/alloy --tail 20
```

No `level=error` lines about `loki.write` means logs are flowing. Check memory while you're at it:

```bash
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
```

`flashcards-control-plane` should be around 2.5 to 3 GB of your 6 GB.

### 8a. Look around before the app is wired in

Grafana, in its own terminal tab (leave it running):

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3001:80
```

The chart generated an admin password. In another tab:

```bash
kubectl get secret -n monitoring monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Open [http://localhost:3001](http://localhost:3001), log in as `admin`. **Dashboards** already has a dozen Kubernetes dashboards that came with the chart: open **Kubernetes / Compute Resources / Namespace (Pods)** and pick `flashcards`. That's your app's CPU and memory, before you wrote a line of monitoring code. **Connections > Data sources** shows Prometheus and Loki.

Prometheus' own UI, in another tab:

```bash
kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090
```

[http://localhost:9090](http://localhost:9090) > **Status > Target health**. Everything the stack monitors about itself is there. No `flashcards` targets yet: the app's PodMonitors arrive in Step 10.

## Step 9: metrics-server and KEDA

`deploy/local/metrics-server-values.yaml`:

```bash
cat > deploy/local/metrics-server-values.yaml <<'EOF'
# metrics-server for the LOCAL kind cluster. It collects CPU and memory per pod, which
# "kubectl top" and the api's HorizontalPodAutoscaler read. Cloud clusters ship with it
# (k3s, EKS add-on); kind doesn't.
# Install (Step 14 of the Phase 6 guide):
#   helm install metrics-server metrics-server/metrics-server --version 3.14.0 \
#     -n kube-system -f deploy/local/metrics-server-values.yaml
args:
  # kind's kubelets use self-signed certificates. Local only: never set this in a real cluster.
  - --kubelet-insecure-tls
EOF
```

```bash
helm install metrics-server metrics-server/metrics-server --version 3.14.0 \
  -n kube-system -f deploy/local/metrics-server-values.yaml --wait --timeout 3m
```

Give it a minute to collect, then:

```bash
kubectl top pods -n flashcards
```

CPU and memory per pod. That's what the HPA reads. KEDA needs no values file:

```bash
helm install keda kedacore/keda --version 2.21.0 -n keda --create-namespace --wait --timeout 5m
kubectl get pods -n keda
```

Three pods: the operator (watches ScaledObjects and the queue), the metrics API server (feeds queue length to the HPA it creates) and admission webhooks (reject broken ScaledObjects).

## Step 10: Deploy and wire it together

Build and deploy your branch, exactly like Phase 3:

```bash
bash scripts/kind-deploy.sh
```

The deploy waits for the api and web to be ready. Then:

```bash
kubectl get pods,hpa,scaledobject -n flashcards
```

What to notice:
- **No worker pod.** The queue is empty, so KEDA scaled it to 0. That's the point.
- `hpa/api` with `cpu: 2%/70%` or so (it may say `<unknown>` for the first minute).
- `hpa/keda-hpa-worker`, created by KEDA, and `scaledobject/worker` with `READY True`, `ACTIVE False` (nothing waiting).

Back to [Prometheus target health](http://localhost:9090/targets): `podMonitor/flashcards/api/0` is **up**. `podMonitor/flashcards/worker/0` has 0 targets, because there are 0 workers. Expected.

Upload a lecture through the app ([http://localhost:8080](http://localhost:8080), or the smoke test script):

```bash
bash scripts/smoke-test.sh deploy/helm/flashcards/files/smoke.pdf
```

It passes, a bit slower than before: about 5 to 15 seconds for KEDA to notice the job and start a worker. **That's the cost of scale-to-zero: a cold start on the first job after idle.** For a background job queue nobody's staring at, that's a great trade. For a user-facing API it usually isn't, which is why the api's HPA has `minReplicas: 1`.

### 10a. PromQL by hand

In the Prometheus UI, **Query** tab, try each and click **Graph**:

```
flashcards_queue_jobs
```
```
sum by (status) (flashcards_jobs_total)
```
```
sum by (handler, status) (rate(http_requests_total{namespace="flashcards"}[5m]))
```
```
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{namespace="flashcards"}[5m])))
```

The last one is the api's p95 latency. In fake mode, `flashcards_llm_tokens_total` doesn't exist yet: fake mode never calls the API, so there are no tokens to count.

### 10b. The dashboard

Grafana > **Dashboards** > **Flashcards**. Namespace `flashcards` at the top. Stats along the top, request rate and latency, jobs and durations, the **Queue vs workers** panel (you'll watch KEDA in it next), LLM tokens and cost, and the api and worker logs at the bottom from Loki. Click a log line to expand it.

Logs on their own: **Explore** > Loki > code mode:

```
{namespace="flashcards", container="worker"} |= "status="
```

Every job's summary line. `|= "status=failed"` narrows it to failures. That's how you go from "the failure rate panel spiked" to "which job, and why" in two clicks.

## Step 11: Learn it by breaking it

### 11a. The api waits for the database

```bash
kubectl scale statefulset postgres -n flashcards --replicas=0
kubectl rollout restart deployment api -n flashcards
kubectl get pods -n flashcards -l app.kubernetes.io/component=api -w
```

Watch for about a minute (Ctrl+C to stop watching). The new api pod stays `0/1 Running` with **0 restarts**, and the old pod keeps serving: the rollout won't finish until the new one is ready. Its logs show the retries:

```bash
kubectl logs -n flashcards deploy/api --tail 5
```

Is the dashboard missing anything during this? The new pod hasn't started serving `/metrics` yet, but the old one has, so no gap. Bring Postgres back:

```bash
kubectl scale statefulset postgres -n flashcards --replicas=1
kubectl rollout status deployment api -n flashcards
```

`successfully rolled out`, and still 0 restarts. Before Phase 6, the same experiment was a `CrashLoopBackOff`.

### 11b. Watch KEDA scale

Make each fake job take 20 seconds, so a burst of uploads actually queues:

```bash
bash scripts/kind-deploy.sh --set config.FAKE_LLM_DELAY_SECONDS=20
```

In a separate tab, watch the workers:

```bash
kubectl get deployment worker -n flashcards -w
```

Upload 12 lectures at once:

```bash
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " -F file=@deploy/helm/flashcards/files/smoke.pdf http://localhost:8080/api/jobs; done; echo
```

Twelve `202`s. Within seconds the worker Deployment goes 0, 1, then up to 5 (12 waiting / 2 per worker = 6, capped at `maxReplicas: 5`). On the dashboard's **Queue vs workers** panel, jobs waiting spikes, worker pods follow it up, the queue drains, and about 5 minutes after it empties (the cooldown), workers drop back to 0.

```bash
kubectl describe scaledobject worker -n flashcards
```

The events at the bottom show KEDA's decisions.

### 11c. Scale-down never loses a job

Upload one job, give a worker a few seconds to pick it up, then kill that worker while it's busy:

```bash
curl -s -F file=@deploy/helm/flashcards/files/smoke.pdf http://localhost:8080/api/jobs; echo
```

```bash
kubectl get pods -n flashcards -l app.kubernetes.io/component=worker
```

Wait until a worker is `Running` (a few seconds), then, with its name:

```bash
kubectl logs -f -n flashcards <worker-pod-name> &
kubectl delete pod -n flashcards <worker-pod-name>
```

The log shows `warm shut down requested`, then the job finishing (`status=done`), then `stopping on request`, and only then does `delete` return. That's SIGTERM, warm shutdown and the 630 second grace period working together. (Press Enter, then `kill %1` if the background `logs -f` is still around.)

### 11d. Fire the failure alert

`fixtures/corrupted.pdf` from Phase 1 starts with `%PDF`, so the api accepts it, and the worker fails on it. Ten of those:

```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code} " -F file=@fixtures/corrupted.pdf http://localhost:8080/api/jobs; done; echo
```

In Prometheus, **Alerts**: `FlashcardsJobFailureRateHigh` goes **Pending** within a minute or so (the condition is true), then **Firing** after its `for: 5m`. Alertmanager's UI shows it too:

```bash
kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-alertmanager 9093:9093
```

[http://localhost:9093](http://localhost:9093). In a company, Alertmanager would now post to Slack or page whoever's on call. On the dashboard: the failure rate stat is red and the job panel shows the `failed` line. Then **Explore** > Loki with `{namespace="flashcards", container="worker"} |= "status=failed"` to find the actual error. Metrics tell you *something* is wrong, logs tell you *what*. The alert resolves by itself about 15 minutes later, once the failures age out of the window.

### 11e. Fire the queue alert

Pretend KEDA (or the workers) broke: pause KEDA at 0 workers, then queue a job.

```bash
kubectl annotate scaledobject worker -n flashcards autoscaling.keda.sh/paused-replicas="0" --overwrite
curl -s -F file=@deploy/helm/flashcards/files/smoke.pdf http://localhost:8080/api/jobs; echo
```

Watch **Oldest wait** on the dashboard climb. Past 600 seconds plus the alert's `for: 1m`, `FlashcardsQueueBackedUp` fires. (Go get a coffee, it's 11 minutes.) Unpause:

```bash
kubectl annotate scaledobject worker -n flashcards autoscaling.keda.sh/paused-replicas-
```

A worker appears, the job runs, the alert resolves.

### 11f. The api's HPA (optional)

The api barely uses CPU, so the easiest way to see the HPA move is to temporarily make the target tiny:

```bash
kubectl patch hpa api -n flashcards --type merge -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":5}}}]}}'
kubectl run load --rm -i --restart=Never --image=curlimages/curl:8.22.0 -n flashcards -- sh -c 'for i in $(seq 1 3000); do curl -s -o /dev/null http://api:8000/health; done'
kubectl get hpa api -n flashcards
```

If CPU went over 5% you'll see 2 or 3 replicas. Now put the real target back. Helm 4 uses **server-side apply**, where Kubernetes records which tool owns each field. Your `kubectl patch` now owns `.spec.metrics`, so a plain redeploy fails with `conflict with "kubectl-patch"`, because Kubernetes won't let Helm silently overwrite someone's manual change. Delete the patched HPA so Helm creates it fresh, then redeploy:

```bash
kubectl delete hpa api -n flashcards
bash scripts/kind-deploy.sh
kubectl get hpa -n flashcards
```

`api` is back at `/70%`. That conflict is exactly what happens at companies when someone hot-fixes production with `kubectl` and the next deploy collides with it.

That last step also turns the fake delay back off.

## Step 12: Commit, PR, merge

Check the branch and the file list. It should be only this phase's files, with **no** `evals/results/`:

```bash
git branch --show-current
git add -A apps evals deploy scripts .github .gitignore ruff.toml guides
git status
```

```bash
git commit -m "Phase 6: AI evals in CI, Prometheus/Grafana/Loki monitoring, KEDA and HPA autoscaling"
git push -u origin phase6-observability
gh pr create --fill
gh pr checks --watch
```

This PR changes `apps/worker/` and `evals/`, so **Detect changes** says yes and **AI evals** runs. When it's green, open the run (`gh pr checks` prints the link) > **Summary**: the score table is there. Merge:

```bash
gh pr merge --squash --delete-branch
```

Release builds new images and the bot updates `values-staging.yaml` as always. Staging and prod are destroyed, so nothing deploys, and nothing costs anything. The next time you `terraform apply` staging, it comes up with the new images (startup probe and sync waves included) and monitoring off.

```bash
git switch main
git pull
```

One last check that the gate is *selective*: a PR that only touches, say, the README should show **AI evals** as **skipped** and **CI passed** green. You'll see that on your next docs PR.

## Troubleshooting

Same rule as always: look, don't guess. `kubectl get pods -A` for what's not running, `kubectl describe` for why, `kubectl logs` for what it said.

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Laptop crawling, pods restarting with probe timeouts, `kubectl` slow | Docker Desktop out of memory | Step 0's 6 GB; `docker stats`; stop other containers. `helm uninstall loki alloy -n monitoring` frees about 300 MB if you have to |
| `kind-deploy.sh`: `no matches for kind "PodMonitor"` (or `ScaledObject`) | Chart deployed before the operator that owns that kind | Steps 8 and 9 first. Or deploy with `--set monitoring.enabled=false` / `--set autoscaling.worker.enabled=false` |
| No `flashcards` targets in Prometheus | PodMonitors ignored | The three `NilUsesHelmValues: false` lines; `kubectl get podmonitors -n flashcards` |
| api target `down`, `server returned HTTP status 404` | Old api image without `/metrics` | `kind-deploy.sh` again; `kubectl get pods -n flashcards -o jsonpath='{..image}'` shows the tag |
| Dashboard missing in Grafana | ConfigMap not labelled, or sidecar not watching all namespaces | `kubectl get cm -n flashcards -l grafana_dashboard=1`; `kubectl logs -n monitoring deploy/monitoring-grafana -c grafana-sc-dashboard` |
| Dashboard panels say "No data" | No traffic yet, or wrong namespace selected | Upload a lecture; check the namespace dropdown says `flashcards` |
| Logs panel empty | Alloy not shipping | `kubectl logs -n monitoring deploy/alloy`; in Explore try `{namespace="flashcards"}` with no filter |
| Loki pod `Pending` | PVC can't bind, or not enough memory | `kubectl describe pod -n monitoring loki-0` |
| Worker never starts after uploads | KEDA can't reach Redis, or paused | `kubectl describe scaledobject worker -n flashcards`; `kubectl logs -n keda deploy/keda-operator --tail 30`; check the `paused-replicas` annotation from 11e is gone |
| Worker pod `CrashLoopBackOff`, `address already in use` | Something else on 9100 inside the pod | Shouldn't happen; set `METRICS_PORT` in `config` and change the port in `worker.yaml` together |
| `kind-deploy.sh`: `UPGRADE FAILED ... conflict with "kubectl-patch"` | A field was changed by hand with `kubectl patch`/`edit`, and server-side apply won't let Helm overwrite it | Delete that object (`kubectl delete hpa api -n flashcards`) and redeploy, or `helm upgrade --force-conflicts` |
| Laptop fans spin up, then `kubectl`: `TLS handshake timeout`, many restarts in `kube-system` | CPU restart storm: the API server is too slow, and controllers restart, which adds load | Stop sending load and wait 10 to 15 minutes; it usually recovers. If not, `docker restart flashcards-control-plane` |
| `hpa/api` stuck at `<unknown>` | metrics-server not ready or missing `--kubelet-insecure-tls` | `kubectl top pods -n flashcards`; `kubectl logs -n kube-system deploy/metrics-server` |
| `run-evals.sh`: `AuthenticationError`, or an error about authentication | Key not exported in this tab | Step 5b's `export` line |
| `run-evals.sh`: `Cannot connect to the Docker daemon` | Docker Desktop not running | Start it |
| CI **AI evals**: `ANTHROPIC_API_KEY secret is missing` | Secret not set (or Dependabot PR without the Dependabot copy) | Step 6a |
| CI **AI evals** fails on a PR you think is fine | Real quality drop, or normal wobble near the threshold | Download the `eval-results` artifact and read the cards. If it's wobble, re-run the job; if it keeps happening, your threshold is too tight (Step 5b) |
| CI **AI evals** runs on every PR | Path filter matching too much | The `Detect changes` log prints the changed files |

If you get stuck, paste the failing command's output in the thread and we'll go through it.

## Daily start and stop

The monitoring stack uses memory even when idle. When you're done for the day:

```bash
docker stop flashcards-control-plane
```

That pauses the whole cluster (all your installs survive). Next time:

```bash
docker start flashcards-control-plane
kubectl get pods -A
```

Give it a minute or two to settle. To remove the monitoring stack entirely (for example before Phase 7 if memory is tight):

```bash
helm uninstall alloy loki monitoring -n monitoring
helm uninstall keda -n keda
helm uninstall metrics-server -n kube-system
```

then redeploy with `bash scripts/kind-deploy.sh --set monitoring.enabled=false --set autoscaling.api.enabled=false --set autoscaling.worker.enabled=false`. (kube-prometheus-stack leaves its CRDs behind on uninstall on purpose; `kubectl get crd | grep monitoring.coreos.com` lists them.)

## Cost check

- **Evals:** a few cents per run, locally and in CI, only on PRs that touch the worker or evals. The `flashcards-ci` workspace's spend limit caps CI no matter what.
- **Smoke tests in the cloud:** unchanged from Phase 5 (when staging and prod are up).
- **AWS:** nothing created in this phase. Both environments should still be destroyed; Step 0's command confirms it.
- **Local:** about 1.2 GB more memory for the stack, $0.

⚠️ No cloud resources in this phase. If you brought staging or prod up for any reason, `terraform destroy` them before you walk away (Phase 5, Step 20).

## What you have at the end

```
flashcards/
  .github/workflows/ci.yml          + Detect changes, AI evals (feeds CI passed)
  .gitignore                        + evals/results/
  ruff.toml                         + evals in src
  apps/api/main.py                  waits for the DB; /metrics with request and queue metrics
  apps/api/tests/test_startup_and_metrics.py    NEW
  apps/worker/
    Dockerfile                      runs worker.main, exposes 9100
    worker/main.py                  NEW: metrics server + SimpleWorker
    worker/tasks.py                 job count, duration, summary log line
    worker/llm.py                   token and cost metrics, FAKE_LLM_DELAY_SECONDS
    tests/                          usage in fakes, metric tests
  evals/                            NEW
    samples/*.txt (+ your PDFs)     the eval set
    scoring.py, run_evals.py        checks and runner
    tests/test_scoring.py           tests for the checks
  deploy/
    helm/flashcards/
      Chart.yaml                    0.2.0
      values.yaml                   autoscaling, monitoring, 630s grace
      values-staging.yaml, values-prod.yaml    monitoring and autoscaling off
      templates/api.yaml            startupProbe, replicas only without HPA
      templates/worker.yaml         metrics port, replicas only without KEDA
      templates/external-secrets.yaml           sync-wave -1
      templates/autoscaling.yaml    NEW: HPA (api), ScaledObject (worker)
      templates/monitoring.yaml     NEW: PodMonitors, PrometheusRule, dashboard ConfigMap
      files/dashboard.json          NEW
    local/metrics-server-values.yaml             NEW
    local/monitoring/               NEW: kube-prometheus-stack, Loki, Alloy values
  scripts/ci-local.sh               + evals scoring tests
  scripts/run-evals.sh              NEW: evals in python:3.12-slim
  guides/phase6-evals-monitoring-autoscaling.md
```

Plus, outside Git: a CI-only Anthropic key with a spend limit, stored as an Actions secret and a Dependabot secret.

## Known gaps (on purpose)

- **Monitoring and autoscaling are kind only.** Bringing them to staging means adding kube-prometheus-stack, Loki, Alloy, metrics-server (k3s already ships one) and KEDA to `deploy/cloud/bootstrap.sh` or, better, as Argo CD Applications, then flipping the flags in `values-staging.yaml`. The catch is memory: the t4g.medium has 4 GB and Argo CD already uses a chunk. Companies usually run one central monitoring stack (or a hosted one like Grafana Cloud) that every cluster ships to, rather than a full stack per cluster.
- **Alerts go nowhere.** Alertmanager has no receivers. The next step is a Slack webhook receiver, stored as a secret, with routing by `severity`.
- **Evals are keyword overlap.** LLM-as-judge (a second model call grading each card against the lecture with a rubric) catches wrong-but-plausible answers that overlap can't. Pair it with a small human-labelled set to check the judge agrees with humans.
- **One eval set, all short lectures, all mine.** Real eval sets grow from production: every bad deck a user reports becomes a new sample. Your own PDFs (Step 4) are the start of that.
- **The eval threshold is one global number.** Per-check thresholds (for example `schema` must be exactly 1.0) and comparing against `main`'s score instead of a fixed number are both common upgrades.
- **Prices are hard-coded in `llm.py`.** Fine for one model; a pricing table in config, or reading actual spend from Anthropic's usage API, is sturdier.
- **SimpleWorker trades isolation for simple metrics.** A crashing job takes the worker down with it. Prometheus multiprocess mode would keep the forking worker.
- **Queue metrics come from every api replica.** With 3 api pods, there are 3 copies of the same number; the dashboard and alerts use `max()` to collapse them. A dedicated exporter would be cleaner at scale.
- **Grafana has no persistence and a generated password.** Dashboards from Git survive restarts (that's the point of the ConfigMap), but anything clicked together in the UI doesn't.
- **Loki stores logs on a local disk.** Production Loki keeps logs in S3 and runs as several scalable components.
- **No tracing.** Metrics and logs, but no request traces across api, Redis and worker. OpenTelemetry (and Langfuse, for LLM call traces with prompts and outputs) is the third pillar.
- **No SLOs.** An SLO like "99% of jobs finish within 2 minutes, measured over 30 days", with alerts on how fast the error budget burns, is how mature teams decide what to alert on.

## Interview talking points from this phase

- "Every PR that touches the prompt or the worker runs an eval: real model, eight sample lectures, scored on schema validity, card count, grounding in the source text, and duplicates. If the score drops below a threshold, the PR can't merge. I set the threshold from three baseline runs because LLM output isn't deterministic."
- "I proved the gate works by running it against a fake model and a deliberately bad prompt. Both failed. A quality gate you've never seen fail isn't tested."
- "The eval job only runs when relevant files change, but it still feeds a single required 'CI passed' check. I skip the job rather than the workflow, because a required check from a workflow that never ran blocks the merge forever."
- "CI uses its own Anthropic key in a separate workspace with a spend limit, and Dependabot gets its own copy because Dependabot PRs can't read normal secrets."
- "The app ships its own monitoring: PodMonitors, alert rules and a Grafana dashboard are in the Helm chart, so they're versioned and deployed with the code they describe."
- "I instrumented request rate, errors and latency on the API, and for the queue: depth, oldest job age, job duration percentiles, failure rate, and LLM tokens and cost per job. I label by route template, never by ID, to avoid cardinality explosions."
- "Queue metrics come from the API, not the worker, because the worker scales to zero."
- "Workers scale with KEDA on Redis queue length, from zero to five, because a worker waiting on an LLM uses no CPU and a CPU-based HPA would never scale it. The API uses a normal CPU HPA with a minimum of one, because cold starts matter for user-facing requests."
- "Scale-down can't lose work: the worker does a warm shutdown on SIGTERM, and the grace period is longer than the job timeout. I tested it by deleting a busy worker and watching the job finish first."
- "I fixed a boot-order race from the cloud deploy at three levels: the app retries the database with backoff, a startup probe gives it time, and Argo CD sync waves create the secret before the app."
- "I used RED metrics plus logs in Loki: an alert tells you something's wrong, the dashboard tells you when and how much, and the logs tell you which job and why."

Once the eval gate has blocked a bad prompt, the dashboard has shown KEDA scale up and back to zero, and both alerts have fired, you're done with week 7. Next up is week 8: the README with the architecture diagram and a "how a deploy works" walkthrough.
