#!/usr/bin/env bash
# Smoke test: upload a PDF, wait for the job to finish, check it produced cards.
# Usage, from the repo root:
#   bash scripts/smoke-test.sh path/to/lecture.pdf
#   bash scripts/smoke-test.sh path/to/lecture.pdf http://localhost:8080   (base URL is optional)
# Exit code 0 = pass, 1 = fail. CI and Argo CD hooks only look at the exit code.
set -euo pipefail

PDF="${1:?Usage: bash scripts/smoke-test.sh path/to/lecture.pdf [base_url]}"
BASE_URL="${2:-http://localhost:8080}"
TIMEOUT_SECONDS=180

if [ ! -f "$PDF" ]; then
  echo "FAIL: file not found: $PDF"
  exit 1
fi

echo "==> Uploading $PDF to $BASE_URL"
response=$(curl -sS --fail-with-body -F "file=@$PDF" "$BASE_URL/api/jobs") || {
  echo "FAIL: upload request failed: $response"
  exit 1
}
job_id=$(echo "$response" | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')
if [ -z "$job_id" ]; then
  echo "FAIL: no job_id in response: $response"
  exit 1
fi
echo "    job_id: $job_id"

echo "==> Waiting for the job to finish (max ${TIMEOUT_SECONDS}s)"
elapsed=0
status=""
while [ "$elapsed" -lt "$TIMEOUT_SECONDS" ]; do
  job=$(curl -sS --fail-with-body "$BASE_URL/api/jobs/$job_id")
  status=$(echo "$job" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  if [ "$status" = "done" ] || [ "$status" = "failed" ]; then
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
echo "    status: ${status:-unknown} after ${elapsed}s"

if [ "$status" != "done" ]; then
  echo "FAIL: job did not finish as done. Last response:"
  echo "$job"
  exit 1
fi

cards=$(echo "$job" | grep -o '"question"' | wc -l | tr -d ' ')
if [ "$cards" -lt 1 ]; then
  echo "FAIL: job is done but has no cards"
  exit 1
fi

if echo "$job" | grep -q '(fake)'; then
  echo "    mode: FAKE_LLM (fake cards)"
else
  echo "    mode: real LLM"
fi
echo "PASS: $cards cards generated"
