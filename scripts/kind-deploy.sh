#!/usr/bin/env bash
# Builds the three images, loads them into the kind cluster and deploys the Helm chart.
# Usage, from the repo root:
#   bash scripts/kind-deploy.sh
#   bash scripts/kind-deploy.sh --set config.FAKE_LLM=0     (extra args go to helm)
set -euo pipefail

CLUSTER=flashcards
NAMESPACE=flashcards

# Tag images with the commit they came from. Uncommitted changes get a unique
# "-dirty-<time>" tag, so Kubernetes always sees a new tag and rolls out the new code.
TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  TAG="$TAG-dirty-$(date +%s)"
fi

for app in web api worker; do
  echo "==> Building flashcards-$app:$TAG"
  docker build -t "flashcards-$app:$TAG" "apps/$app"
  kind load docker-image "flashcards-$app:$TAG" --name "$CLUSTER"
done

echo "==> Deploying $TAG"
helm upgrade --install flashcards deploy/helm/flashcards \
  --namespace "$NAMESPACE" \
  --set image.tag="$TAG" \
  --wait --timeout 3m \
  "$@"

kubectl get pods --namespace "$NAMESPACE"
