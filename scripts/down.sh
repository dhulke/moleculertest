#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "============================================"
echo "  Stopping Moleculer + NATS Demo Cluster"
echo "============================================"
echo ""

docker compose down -v --remove-orphans

echo ""
echo "[down] Cluster stopped and volumes removed."
