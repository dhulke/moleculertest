#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

DISABLE_BALANCER="${DISABLE_BALANCER:-true}"
export DISABLE_BALANCER

if [ "$DISABLE_BALANCER" = "false" ]; then
  MODE_LABEL="CONTROL MODE (disableBalancer=false)"
else
  MODE_LABEL="NORMAL MODE (disableBalancer=true)"
fi

echo "============================================"
echo "  Running Full Validation Suite"
echo "  $MODE_LABEL"
echo "============================================"
echo ""

mkdir -p output output/baseline output/churn output/scale

# Clear previous output files
echo "[validate] Clearing previous output files..."
rm -f output/*.json output/*.md output/*.jsonl 2>/dev/null || true
rm -f output/baseline/*.json 2>/dev/null || true
rm -f output/churn/*.json 2>/dev/null || true
rm -f output/scale/*.json 2>/dev/null || true
rm -f output/node-ready-*.json 2>/dev/null || true
rm -f output/broadcast-receipt-*.jsonl 2>/dev/null || true

# Ensure the running containers match the requested DISABLE_BALANCER value.
# When switching modes we must recreate the baseline services so they pick up
# the new environment variable.
NEED_RESTART="false"
RUNNING=$(docker compose ps -q worker-a-1 2>/dev/null || true)
if [ -n "$RUNNING" ]; then
  CURRENT_VAL=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' worker-a-1 2>/dev/null | grep '^DISABLE_BALANCER=' | cut -d= -f2 || echo "")
  if [ "$CURRENT_VAL" != "$DISABLE_BALANCER" ]; then
    NEED_RESTART="true"
  fi
fi

if [ "$NEED_RESTART" = "true" ]; then
  echo "[validate] Detected DISABLE_BALANCER mismatch (containers=$CURRENT_VAL, requested=$DISABLE_BALANCER)"
  echo "[validate] Recreating baseline services with DISABLE_BALANCER=$DISABLE_BALANCER..."
  docker compose up -d --force-recreate --no-deps \
    worker-a-1 worker-a-2 caller-1 broadcaster-1 \
    listener-b-1 listener-c-1 listener-d-1 listener-e-1 hybrid-1
  echo "[validate] Waiting for services to stabilize..."
  sleep 10
fi

# Ensure dependencies are installed locally for the validator
if [ ! -d "node_modules" ]; then
  echo "[validate] Installing dependencies..."
  npm install
fi

# Build TypeScript
echo "[validate] Building TypeScript..."
npx tsc

# Run the validator from the host, connecting to NATS on localhost
echo "[validate] Starting validation run..."
echo ""
echo "  Configuration:"
echo "    DISABLE_BALANCER=${DISABLE_BALANCER}"
echo "    SKIP_CHURN=${SKIP_CHURN:-false}"
echo "    SKIP_SCALE=${SKIP_SCALE:-false}"
echo "    SCALE_WORKERS=${SCALE_WORKERS:-10}"
echo "    SCALE_LISTENERS=${SCALE_LISTENERS:-10}"
echo ""

NATS_URL="nats://localhost:4222" \
NATS_MONITOR_URL="http://localhost:8222" \
NAMESPACE="demo" \
DISABLE_BALANCER="$DISABLE_BALANCER" \
NODE_ID="validator-1" \
NODE_ROLE="validator" \
OUTPUT_DIR="./output" \
SKIP_CHURN="${SKIP_CHURN:-false}" \
SKIP_SCALE="${SKIP_SCALE:-false}" \
SCALE_WORKERS="${SCALE_WORKERS:-10}" \
SCALE_LISTENERS="${SCALE_LISTENERS:-10}" \
node dist/validation/runValidation.js

EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "============================================"
  echo "  VALIDATION PASSED — $MODE_LABEL"
  echo "============================================"
else
  echo "============================================"
  echo "  VALIDATION COMPLETED WITH ISSUES"
  echo "  $MODE_LABEL (exit code: $EXIT_CODE)"
  echo "============================================"
fi

echo ""
echo "Reports available at:"
echo "  output/report.md"
echo "  output/report.json"
echo ""
echo "Evidence directories:"
echo "  output/baseline/   - NATS snapshots from baseline"
echo "  output/churn/      - Churn test evidence"
echo "  output/scale/      - Scale test evidence"

exit $EXIT_CODE
