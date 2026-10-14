#!/usr/bin/env bash
# Runs the same lint and test steps as CI, before you push.
# Python runs inside python:3.12-slim (same version as CI), so your Mac's Python doesn't matter.
# Usage, from the repo root: bash scripts/ci-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

py() {  # py <folder to mount> <command>
  docker run --rm -v "$PWD/$1":/app -w /app -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
    python:3.12-slim sh -c "pip install -q --root-user-action=ignore -r requirements-dev.txt && $2"
}

echo "== ruff (lint + format check)"
py . "ruff check . && ruff format --check ."

for app in api worker; do
  echo "== pytest ($app)"
  py "apps/$app" "pytest -q -p no:cacheprovider"
done

echo "== eslint"
(cd apps/web && npm run lint)

echo "All local checks passed. Safe to push."
