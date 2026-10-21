#!/usr/bin/env bash
# One command: build the image and the packages.   Usage: docker/build-in-docker.sh [output-directory]
# Requires Docker with linux/amd64 (x86_64 host, or QEMU emulation on arm64: very slow).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$HERE/.." && pwd)"; OUT="${1:-$SRC/out}"
mkdir -p "$OUT"
docker build --platform linux/amd64 -t suwayomi-browser-build "$HERE"
docker run --rm --platform linux/amd64 -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -v "$SRC":/src:ro -v "$(cd "$OUT" && pwd)":/out suwayomi-browser-build
