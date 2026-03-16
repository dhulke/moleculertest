#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# ── Parse flags ──
DISABLE_BALANCER="true"
SKIP_CHURN="${SKIP_CHURN:-false}"
SKIP_SCALE="${SKIP_SCALE:-false}"
SCALE_WORKERS="${SCALE_WORKERS:-10}"
SCALE_LISTENERS="${SCALE_LISTENERS:-10}"

for arg in "$@"; do
  case "$arg" in
    --disable-false)
      DISABLE_BALANCER="false"
      ;;
    --skip-churn)
      SKIP_CHURN="true"
      ;;
    --skip-scale)
      SKIP_SCALE="true"
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Builds, starts, validates, and tears down the full Moleculer + NATS cluster."
      echo ""
      echo "Options:"
      echo "  --disable-false   Run with disableBalancer=false (control experiment)"
      echo "  --skip-churn      Skip the churn stress test suite"
      echo "  --skip-scale      Skip the scale stress test suite"
      echo "  -h, --help        Show this help"
      echo ""
      echo "Environment variables:"
      echo "  SCALE_WORKERS=N   Number of scale-test workers  (default: 10)"
      echo "  SCALE_LISTENERS=N Number of scale-test listeners (default: 10)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)"
      exit 1
      ;;
  esac
done

export DISABLE_BALANCER

if [ "$DISABLE_BALANCER" = "false" ]; then
  MODE_LABEL="CONTROL MODE (disableBalancer=false)"
else
  MODE_LABEL="NORMAL MODE (disableBalancer=true)"
fi

echo "╔══════════════════════════════════════════════╗"
echo "║  Moleculer + NATS — Full Run                ║"
echo "║  $MODE_LABEL  "
echo "╚══════════════════════════════════════════════╝"
echo ""

cleanup() {
  echo ""
  echo "────────────────────────────────────────────"
  echo "  TEARDOWN"
  echo "────────────────────────────────────────────"
  echo "[run-all] Stopping all containers..."
  docker compose --profile churn --profile scale down -v --remove-orphans 2>/dev/null || true
  echo "[run-all] Cluster stopped."
}
trap cleanup EXIT

# ── 1. Build ──
echo "────────────────────────────────────────────"
echo "  STEP 1 / 3 — BUILD & START"
echo "────────────────────────────────────────────"
echo ""

mkdir -p output output/baseline output/churn output/scale

rm -f output/*.json output/*.md output/*.jsonl 2>/dev/null || true
rm -f output/baseline/*.json 2>/dev/null || true
rm -f output/churn/*.json 2>/dev/null || true
rm -f output/scale/*.json 2>/dev/null || true
rm -f output/node-ready-*.json 2>/dev/null || true
rm -f output/broadcast-receipt-*.jsonl 2>/dev/null || true

echo "[run-all] Building Docker images..."
docker compose build

echo "[run-all] Starting NATS..."
docker compose up -d nats

echo "[run-all] Waiting for NATS to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8222/varz > /dev/null 2>&1; then
    echo "[run-all] NATS is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[run-all] ERROR: NATS did not start in time."
    exit 1
  fi
  sleep 1
done

echo "[run-all] Starting baseline Moleculer nodes..."
docker compose up -d

echo "[run-all] Waiting for services to stabilize..."
sleep 8

echo ""
echo "[run-all] Container status:"
docker compose ps
echo ""

# ── 2. Validate ──
echo "────────────────────────────────────────────"
echo "  STEP 2 / 3 — VALIDATE"
echo "────────────────────────────────────────────"
echo ""
echo "  DISABLE_BALANCER=$DISABLE_BALANCER"
echo "  SKIP_CHURN=$SKIP_CHURN"
echo "  SKIP_SCALE=$SKIP_SCALE"
echo "  SCALE_WORKERS=$SCALE_WORKERS"
echo "  SCALE_LISTENERS=$SCALE_LISTENERS"
echo ""

if [ ! -d "node_modules" ]; then
  echo "[run-all] Installing dependencies..."
  npm install
fi

echo "[run-all] Building TypeScript..."
npx tsc

NATS_URL="nats://localhost:4222" \
NATS_MONITOR_URL="http://localhost:8222" \
NAMESPACE="demo" \
DISABLE_BALANCER="$DISABLE_BALANCER" \
NODE_ID="validator-1" \
NODE_ROLE="validator" \
OUTPUT_DIR="./output" \
SKIP_CHURN="$SKIP_CHURN" \
SKIP_SCALE="$SKIP_SCALE" \
SCALE_WORKERS="$SCALE_WORKERS" \
SCALE_LISTENERS="$SCALE_LISTENERS" \
node dist/validation/runValidation.js

VALIDATE_EXIT=$?

# ── 3. Report ──
echo ""
echo "────────────────────────────────────────────"
echo "  STEP 3 / 3 — RESULTS"
echo "────────────────────────────────────────────"
echo ""

if [ $VALIDATE_EXIT -eq 0 ]; then
  echo "  RESULT: PASSED — $MODE_LABEL"
else
  echo "  RESULT: ISSUES DETECTED — $MODE_LABEL (exit $VALIDATE_EXIT)"
fi

echo ""
echo "  Reports:"
echo "    output/report.md"
echo "    output/report.json"
echo ""
echo "  Evidence:"
echo "    output/baseline/"
echo "    output/churn/"
echo "    output/scale/"

# Teardown happens automatically via the EXIT trap

exit $VALIDATE_EXIT
