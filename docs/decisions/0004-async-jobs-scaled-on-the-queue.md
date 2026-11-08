# 0004: Async jobs, workers scaled on the queue

**Status:** Accepted (Phase 1, autoscaling added in Phase 6)

## Context

Turning a lecture into flashcards means an LLM call that can take a minute or more. Doing that inside the HTTP request would tie up an api worker per upload, hit proxy timeouts, and lose the work if the pod restarts. Load is bursty: nothing for hours, then a class uploads before an exam.

## Decision

The api stores the PDF in S3, inserts a `queued` job in Postgres, puts the job ID on a Redis queue (RQ), and returns HTTP 202 with the ID. A separate worker Deployment takes jobs from the queue. The browser polls `GET /api/jobs/{id}`.

The worker scales with KEDA on queue length: one worker per two waiting jobs, up to five, and zero after five idle minutes. The api scales with a normal CPU HPA, minimum one.

## Consequences

- The api stays fast and up even when the model is slow or down.
- Workers cost nothing when idle, and burst when needed. A CPU autoscaler couldn't do this: a worker waiting on the model barely uses CPU.
- Scaling to zero means the first job after a quiet period waits for a pod to start.
- Scale-down and deploys must not kill a job halfway: the worker finishes its current job on SIGTERM, and its grace period (630s) is longer than the job timeout (600s).
- Polling is simple but chatty. Server-sent events or websockets would be the upgrade.
- Queue metrics come from the api, because a worker that's scaled to zero can't report how many jobs are waiting.
