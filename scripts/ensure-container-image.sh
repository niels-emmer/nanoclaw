#!/usr/bin/env bash
# Checks for the nanoclaw-agent Docker image and rebuilds it if missing.
# Run as ExecStartPre in the nanoclaw systemd service so the crash-retry
# loop can't occur: a missing image is rebuilt before the service starts.
set -euo pipefail

IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_SCRIPT="$SCRIPT_DIR/../container/build.sh"

if docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "ensure-container-image: $IMAGE exists, skipping build"
  exit 0
fi

echo "ensure-container-image: $IMAGE not found — rebuilding..."
exec "$BUILD_SCRIPT"
