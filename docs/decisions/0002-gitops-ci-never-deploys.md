# 0002: GitOps with Argo CD, CI never deploys

**Status:** Accepted (Phase 4, week 5)

## Context

The usual first version of a deploy pipeline is CI running `kubectl apply` or `helm upgrade` at the end. That means CI holds credentials that can change anything in the cluster, and any workflow change (or a compromised action) can use them. It also means what's in the cluster and what's in Git can drift apart when someone fixes something by hand.

## Decision

Argo CD runs inside each cluster and syncs from `main` (`deploy/argocd/`). CI's last step is a Git commit that changes the image tag in a values file. Automated sync has `prune` (delete what was removed from Git) and `selfHeal` (undo changes made by hand) turned on.

## Consequences

- CI has no cluster credentials at all. The cluster only needs read access to a public repo.
- Git is the deploy log. `git log` on a values file lists every deploy, who approved it and which run made it. A rollback is `git revert`.
- Manual fixes in the cluster get reverted within minutes. That's the point, but it surprises people during an incident: the fix has to go through Git.
- Deploys aren't instant: Argo CD polls every 60 seconds.
- The bot needs to push to a protected `main`, which takes a deploy key on the ruleset's bypass list. That key is a credential to guard (it lives in a GitHub Environment limited to `main`).
