# Runbook

Commands for running this thing day to day. Everything assumes you're in the repo root.

## Local

Start the kind cluster after a reboot (installs survive a stop):

```bash
docker start flashcards-control-plane
```

Pause it when you're done (the monitoring stack uses about 1.2 GB):

```bash
docker stop flashcards-control-plane
```

Deploy your working copy to kind:

```bash
bash scripts/kind-deploy.sh
```

Make the bad-input test files (corrupted, empty, fake and oversized PDFs) for poking at the upload validation by hand. They land in `fixtures/`, which is gitignored because two of them are over 20 MB:

```bash
python3 scripts/make-fixtures.py
```

## Cloud environments

Both are off unless I'm using them. Build one (about 15 minutes, about $0.06/hour while up):

```bash
terraform -chdir=infra/terraform/envs/staging apply
```

The VM's first boot installs k3s, cert-manager, External Secrets and Argo CD (`deploy/cloud/bootstrap.sh`), then Argo CD deploys the app from `main`. To use `kubectl` against it, open the SSM tunnel and leave it running:

```bash
bash scripts/cloud-connect.sh staging
```

Then in another tab:

```bash
export KUBECONFIG=~/.kube/flashcards-staging.yaml
```

**Turn it off when you're done.** This is the only thing that stops the bill:

```bash
terraform -chdir=infra/terraform/envs/staging destroy
```

Swap `staging` for `prod` in all of the above for prod.

## Roll back a deploy

Revert the bot's `Deploy ... to staging/prod` commit through a PR. Details in [how-a-deploy-works.md](how-a-deploy-works.md#rolling-back).

## Rotate the Anthropic API key

1. Make the new key in the Anthropic console.
2. Store it without it landing in your shell history. Paste the key at the prompt (nothing shows), then press Enter:

```bash
read -rs NEW_KEY
```

```bash
aws secretsmanager put-secret-value --secret-id flashcards/staging/anthropic-api-key --secret-string "$NEW_KEY"
```

3. External Secrets re-reads every hour (`refreshInterval: 1h`). To pull it now:

```bash
kubectl annotate externalsecret flashcards-secrets -n flashcards-staging force-sync="$(date +%s)" --overwrite
```

4. Pods read env vars at start, so restart the worker:

```bash
kubectl rollout restart deployment/worker -n flashcards-staging
```

5. Delete the old key in the Anthropic console. Repeat for prod. The CI key is separate: update the `ANTHROPIC_API_KEY` Actions secret and Dependabot secret in the repo settings.

## When an alert fires

Alerts are defined in `deploy/helm/flashcards/templates/monitoring.yaml`.

**FlashcardsJobFailureRateHigh** (more than 5% of jobs failed over 15 minutes, for 5 minutes)

1. Grafana, flashcards dashboard: did failures start at a deploy? Then roll back.
2. Loki, worker logs, search `status=failed`. Each failed job logs its ID and the error.
3. Common causes: Anthropic API errors or an expired key, PDFs with no text layer, a bad prompt change that got past the evals.

**FlashcardsQueueBackedUp** (oldest job has waited 10+ minutes)

1. Are there workers? `kubectl get pods -n flashcards -l app.kubernetes.io/component=worker` (use your environment's namespace: `flashcards` on kind, `flashcards-staging` or `flashcards-prod` in the cloud).
2. Is KEDA scaling? `kubectl get scaledobject worker -n flashcards` should show READY True and the right target.
3. Are workers stuck? Look for a job running far longer than usual in the worker logs. Jobs time out after 600 seconds.

## The kill switch fired

An AWS budget email saying the $10 kill switch threshold was crossed means a Lambda stopped every EC2 VM and RDS database tagged `Project=flashcards`. Stopped isn't deleted: disks still cost a little, and AWS restarts a stopped RDS after 7 days by itself. Decide which one you want:

- Done with it: `terraform destroy` the environment (above).
- Still need it: find out what spent the money first (Billing, Cost Explorer, group by tag `Environment`).
