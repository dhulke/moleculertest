#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

DISABLE_BALANCER="${DISABLE_BALANCER:-true}"
export DISABLE_BALANCER

echo "============================================"
echo "  Starting Moleculer + NATS Demo Cluster"
echo "  disableBalancer=$DISABLE_BALANCER"
echo "============================================"
echo ""

mkdir -p output

echo "[up] Building Docker images..."
docker compose build

echo "[up] Starting NATS..."
docker compose up -d nats
echo "[up] Waiting for NATS to be ready..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:8222/varz > /dev/null 2>&1; then
    echo "[up] NATS is ready."
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "[up] ERROR: NATS did not start in time."
    exit 1
  fi
  sleep 1
done

echo "[up] Starting baseline Moleculer nodes..."
docker compose up -d

echo ""
echo "[up] Waiting for all containers to be running..."
sleep 5

echo ""
echo "[up] Container status:"
docker compose ps

echo ""
echo "[up] Baseline cluster is up."
echo ""
echo "Available commands:"
echo "  ./scripts/validate.sh                     Run full validation (baseline + churn + scale)"
echo "  SKIP_SCALE=true ./scripts/validate.sh     Run baseline + churn only"
echo "  SKIP_CHURN=true ./scripts/validate.sh     Run baseline + scale only"
echo "  SKIP_CHURN=true SKIP_SCALE=true ./scripts/validate.sh   Baseline only"
echo ""
echo "Configuration:"
echo "  SCALE_WORKERS=20 SCALE_LISTENERS=20 ./scripts/validate.sh   Custom scale counts"
