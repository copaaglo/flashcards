# Architecture

How the running system fits together. The diagram is on the [front page](../README.md#architecture); this page explains why it looks the way it does.

## Why the work is async

The api answers the upload in milliseconds with a job ID (HTTP 202) and never waits for the model. The slow part, an LLM call that can take a minute, happens in the worker. That split is the main design decision:

- **The api stays fast** no matter how long the model takes, and a model outage doesn't take the website down with it.
- **Workers scale on their own.** KEDA watches the Redis queue and runs one worker per two waiting jobs, up to five, and zero when there's nothing to do. A worker waiting on the model uses almost no CPU, so a normal CPU autoscaler would never scale it.
- **A job survives a restart.** It's a row in Postgres and an entry in Redis, not a request held open in memory.

The browser talks only to `web`. nginx serves the React build and forwards `/api/*` to the api inside the cluster, so there's one hostname and no CORS.

## Environments

| | Local (Compose) | Local (kind) | Staging | Prod |
|---|---|---|---|---|
| Runs on | Docker Compose | kind cluster on my Mac | k3s on one t4g.medium EC2 VM | Same, separate VM, VPC and database |
| Deployed by | `docker compose up` | `scripts/kind-deploy.sh` (Helm) | Argo CD, automatically on merge | Argo CD, after approval |
| Values file | none | `values.yaml` | `values-staging.yaml` | `values-prod.yaml` |
| LLM | real or fake (`FAKE_LLM`) | fake by default | real | real |
| Database / files | Postgres + SeaweedFS containers | same, in the cluster | RDS + S3 | RDS + S3 |
| Monitoring, KEDA | no | yes | not yet | not yet |
| URL | http://localhost:3000 | http://localhost:8080 | https://staging.app.cramcards.ca | https://app.cramcards.ca |

The cloud environments are **off most of the time**. Terraform builds one in about 15 minutes and `terraform destroy` removes it; see [Security and cost](security-and-cost.md#cost-and-turning-it-off).


## Observability

The api and worker expose Prometheus metrics. The Helm chart ships its own PodMonitors, alert rules and a Grafana dashboard, so monitoring is versioned and deployed with the code it watches.

- **api:** request rate, errors and latency per route, queue depth, age of the oldest waiting job
- **worker:** jobs done and failed, job duration, LLM tokens and estimated cost per model
- **Alerts:** job failure rate above 5% for 5 minutes, queue backed up for 10+ minutes
- **Logs:** every pod's logs in Loki, next to the metrics in Grafana

Right now this runs on the kind cluster. Staging and prod have it switched off (see [Known gaps](known-gaps.md)).

