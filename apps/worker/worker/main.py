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
