#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tag="${1:-main-$(git rev-parse --short=7 HEAD)}"
for component in backend frontend; do
  image="ghcr.io/ondc-official/rsf-bulk-utility-${component}:${tag}"
  docker build --platform linux/amd64 -f "Dockerfile.${component}" -t "$image" .
  architecture="$(docker image inspect "$image" --format '{{.Architecture}}')"
  if [[ "$architecture" != amd64 ]]; then
    echo "Refusing to publish $image: expected amd64, got $architecture" >&2
    exit 1
  fi
  docker push "$image"
done
