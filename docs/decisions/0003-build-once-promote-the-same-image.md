# 0003: Build once, promote the same image

**Status:** Accepted (Phases 4 and 5)

## Context

If staging and prod each build their own images, prod runs a build nobody tested: a base image or a dependency can change between the two builds. Tags like `latest` or `v1` make it worse, because the same tag can point at different code on different days, and "what's in prod right now?" has no exact answer.

## Decision

Images are built once, on merge to `main`, for amd64 and arm64, and tagged only with the full commit SHA (`release.yml`). Staging gets that tag. Promotion to prod (`promote-prod.yml`) copies the tag from `values-staging.yaml` to `values-prod.yaml`, after a required reviewer approves. It refuses anything that isn't a 40 character SHA.

## Consequences

- Prod runs byte for byte the image staging ran, and every running image maps to one commit.
- Rolling back is pointing at an older SHA. The image is still in GHCR, nothing rebuilds.
- Config differences between environments live in the values files, not in the image. The same image has to work everywhere, so anything environment-specific is an env var.
- Only images are promoted. The chart's templates come from `main` for both environments, so template changes skip the staging step (see the known gaps in [how a deploy works](../how-a-deploy-works.md#known-gaps-in-this-process)).
