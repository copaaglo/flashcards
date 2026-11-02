#!/usr/bin/env bash
# Opens a private tunnel from your Mac to a cloud cluster's Kubernetes API, through
# AWS Systems Manager (SSM). No SSH, no open ports on the VM.
#   bash scripts/cloud-connect.sh staging      (or prod)
# Leave it running. In another terminal tab:
#   export KUBECONFIG=~/.kube/flashcards-staging.yaml
#   kubectl get nodes
set -euo pipefail

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  staging) LOCAL_PORT=16443 ;;
  prod) LOCAL_PORT=26443 ;;
  *) echo "usage: bash scripts/cloud-connect.sh staging|prod"; exit 1 ;;
esac
export AWS_REGION="${AWS_REGION:-us-east-1}"
KUBECONFIG_FILE="$HOME/.kube/flashcards-$ENVIRONMENT.yaml"

INSTANCE_ID="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=flashcards-$ENVIRONMENT" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "No running flashcards-$ENVIRONMENT VM. Did terraform apply finish?"
  exit 1
fi
echo "VM: $INSTANCE_ID"

# Read k3s's admin kubeconfig by running one command on the VM through SSM
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["cat /etc/rancher/k3s/k3s.yaml"]' --query Command.CommandId --output text)"
aws ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
mkdir -p "$HOME/.kube"
# The file points at 127.0.0.1:6443 on the VM. We reach it through the tunnel on LOCAL_PORT.
aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text \
  | sed "s|https://127.0.0.1:6443|https://127.0.0.1:$LOCAL_PORT|" > "$KUBECONFIG_FILE"
# It's a cluster-admin credential, so only you can read it
chmod 600 "$KUBECONFIG_FILE"
grep -q "127.0.0.1:$LOCAL_PORT" "$KUBECONFIG_FILE" || { echo "Kubeconfig looks wrong, k3s may still be installing. Try again in a minute."; exit 1; }
echo "Wrote $KUBECONFIG_FILE"

echo "Tunnel: 127.0.0.1:$LOCAL_PORT -> $INSTANCE_ID:6443. Leave this running, Ctrl+C closes it."
exec aws ssm start-session --target "$INSTANCE_ID" --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=6443,localPortNumber=$LOCAL_PORT"
