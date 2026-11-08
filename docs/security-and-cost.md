# Security and cost

## Security

- **No secrets in Git.** The database URL and API key live in AWS Secrets Manager; External Secrets copies them into the cluster. Locally they come from a gitignored `.env`.
- **No long-lived cloud keys in the cluster.** Pods reach S3 and Secrets Manager through the VM's IAM role, scoped to that environment's bucket and secrets.
- **No inbound SSH.** The VMs only open 80 and 443. I reach the Kubernetes API through an AWS SSM tunnel (`scripts/cloud-connect.sh`).
- **CI can't touch the clusters.** Workflows get read-only tokens by default. The deploy bot pushes with deploy keys that live in GitHub Environments limited to `main`, and prod's key sits behind a required reviewer.
- **Supply chain.** Third-party actions are pinned to commit SHAs, Dependabot keeps them current, the kind node image is pinned by digest, and Trivy scans every image.


## Cost and turning it off

| Item | Cost |
|---|---|
| One cloud environment while it's up (VM + RDS + disk) | about $0.06/hour |
| Always on: state bucket, secrets, Route 53 zone, budgets | about $1.80/month |
| An eval run in CI | a few cents |
| Everything local | $0 |

EKS would cost about $70/month for the control plane alone, so each environment is k3s on one VM instead (see [ADR 0001](decisions/0001-k3s-on-one-vm-instead-of-eks.md)). A $10/month AWS budget triggers a Lambda that stops every VM and database tagged `Project=flashcards`, as a safety net. The real off switch is:

```bash
terraform -chdir=infra/terraform/envs/staging destroy
```

