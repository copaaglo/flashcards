# Design decisions

Architecture Decision Records (ADRs): one short file per decision, written when it was made. Each one says what the situation was, what I chose, and what that costs. They don't get edited later; if a decision changes, a new ADR replaces the old one and says so.

| # | Decision | Status |
|---|---|---|
| [0001](0001-k3s-on-one-vm-instead-of-eks.md) | k3s on one VM instead of EKS | Accepted |
| [0002](0002-gitops-ci-never-deploys.md) | GitOps with Argo CD, CI never deploys | Accepted |
| [0003](0003-build-once-promote-the-same-image.md) | Build once, promote the same image | Accepted |
| [0004](0004-async-jobs-scaled-on-the-queue.md) | Async jobs, workers scaled on the queue | Accepted |
| [0005](0005-ai-evals-as-a-merge-gate.md) | AI evals as a merge gate | Accepted |

New one: copy the newest file, bump the number, keep it under a page.
