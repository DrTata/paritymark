#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (one level up from scripts/)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[dev:web] Checking for processes on ports 3000 and 3001..."

for PORT in 3000 3001; do
  PIDS=$(ss -tulpn 2>/dev/null | awk -v p=":${PORT} " '$0 ~ p {print $NF}' | sed -E 's/.*pid=([0-9]+),.*/\1/')
  if [ -n "$PIDS" ]; then
    echo "[dev:web] Killing process(es) on port ${PORT}: ${PIDS}"
    # shellcheck disable=SC2086
    kill $PIDS || true
  else
    echo "[dev:web] No processes found on port ${PORT}."
  fi
done

echo "[dev:web] Removing dev lock directory apps/web/.next/dev (if present)..."
rm -rf apps/web/.next/dev

echo "[dev:web] Starting web dev server via Turborepo..."
exec pnpm turbo dev --filter=web
