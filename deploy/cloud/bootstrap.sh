#!/usr/bin/env bash
# Turns a fresh k3s VM into a cluster that Argo CD deploys the app to.
# cloud-init runs it once, as root, on the VM's first boot (infra/terraform/modules/cluster).
# Safe to run again by hand if a step failed, from a shell on the VM:
#   sudo bash /opt/flashcards/deploy/cloud/bootstrap.sh staging
set -euo pipefail

ENVIRONMENT="${1:?usage: bootstrap.sh staging|prod}"

# Pinned versions, each at least two weeks old when picked
HELM_VERSION=v4.3.1
CERT_MANAGER_VERSION=v1.21.2
EXTERNAL_SECRETS_VERSION=2.12.0
ARGOCD_CHART_VERSION=10.10.5

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# cloud-init may run us without HOME, and Helm keeps its repo list under it
export HOME="${HOME:-/root}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Helm $HELM_VERSION"
if ! helm version 2>/dev/null | grep -q "$HELM_VERSION"; then
  arch="$(uname -m | sed 's/aarch64/arm64/; s/x86_64/amd64/')"
  tarball="helm-${HELM_VERSION}-linux-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$tarball" "https://get.helm.sh/$tarball"
  curl -fsSL -o "$tmp/$tarball.sha256sum" "https://get.helm.sh/$tarball.sha256sum"
  # Refuse to install a download that doesn't match its published checksum
  (cd "$tmp" && sha256sum -c "$tarball.sha256sum")
  tar -xzf "$tmp/$tarball" -C "$tmp"
  install -m 0755 "$tmp/linux-${arch}/helm" /usr/local/bin/helm
  rm -rf "$tmp"
fi

echo "==> Waiting for the node"
until kubectl get nodes >/dev/null 2>&1; do sleep 5; done
kubectl wait --for=condition=Ready node --all --timeout=300s

helm repo add jetstack https://charts.jetstack.io --force-update
helm repo add external-secrets https://charts.external-secrets.io --force-update
helm repo add argo https://argoproj.github.io/argo-helm --force-update

echo "==> cert-manager: gets HTTPS certificates from Let's Encrypt"
helm upgrade --install cert-manager jetstack/cert-manager --version "$CERT_MANAGER_VERSION" \
  --namespace cert-manager --create-namespace --set crds.enabled=true --wait --timeout 10m

echo "==> External Secrets: copies secrets from AWS Secrets Manager into Kubernetes"
helm upgrade --install external-secrets external-secrets/external-secrets --version "$EXTERNAL_SECRETS_VERSION" \
  --namespace external-secrets --create-namespace --wait --timeout 10m

echo "==> Argo CD"
helm upgrade --install argocd argo/argo-cd --version "$ARGOCD_CHART_VERSION" \
  --namespace argocd --create-namespace -f "$REPO_DIR/deploy/argocd/argocd-values.yaml" --wait --timeout 10m

echo "==> Handing flashcards-$ENVIRONMENT to Argo CD"
kubectl apply -n argocd -f "$REPO_DIR/deploy/argocd/flashcards-$ENVIRONMENT.yaml"

echo "==> Bootstrap done. Argo CD deploys the app from Git now."
