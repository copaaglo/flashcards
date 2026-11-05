#!/usr/bin/env bash
# Runs the AI evals inside python:3.12-slim (same Python as CI), so your Mac's Python doesn't matter.
# Usage, from the repo root:
#   bash scripts/run-evals.sh                    real model, needs ANTHROPIC_API_KEY exported
#   FAKE_LLM=1 bash scripts/run-evals.sh         free, and should FAIL
#   bash scripts/run-evals.sh --threshold 0.9    extra args go to evals/run_evals.py
# Exits with run_evals.py's exit code: 0 pass, 1 fail.
set -euo pipefail
cd "$(dirname "$0")/.."

# -e NAME with no value passes the variable through only if it's set here
docker run --rm -v "$PWD":/repo -w /repo \
  -e ANTHROPIC_API_KEY -e FAKE_LLM -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
  python:3.12-slim \
  sh -c 'pip install -q --root-user-action=ignore -r evals/requirements.txt && python evals/run_evals.py "$@"' \
  sh "$@"
