# 0001: k3s on one VM instead of EKS

**Status:** Accepted (Phase 5, week 6)

## Context

The app needs a Kubernetes cluster in the cloud for staging and one for prod. It's a learning project with no real users, paid out of pocket, and both environments are destroyed when not in use. EKS charges about $70/month per cluster for the control plane alone, before any worker nodes. The work I want to practice (Helm, Argo CD, External Secrets, cert-manager, ingress) is the same on any conformant Kubernetes.

## Decision

Each environment is one `t4g.medium` ARM EC2 VM running k3s, built by `infra/terraform/modules/cluster`. Postgres is RDS (managed, private subnet), uploads are S3. Kubernetes add-ons are installed on first boot by `deploy/cloud/bootstrap.sh`.

## Consequences

- An environment costs about $0.06/hour instead of $0.10/hour for the EKS control plane alone, and can be destroyed and rebuilt in about 15 minutes.
- One VM is a single point of failure: if it dies, the environment is down until Terraform replaces it. Acceptable for staging, and for a prod with no users.
- I don't learn EKS-specific pieces: managed node groups, IRSA / Pod Identity for per-pod IAM, the AWS Load Balancer Controller. Pods share the VM's IAM role instead of having one each.
- Moving to EKS later changes `modules/cluster` and the bootstrap, not the chart or the Argo CD setup.
