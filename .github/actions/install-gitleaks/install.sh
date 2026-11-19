#!/usr/bin/env bash
#
# Install gitleaks from its release tarball, or from the image of the same
# version when the release host is down. A security gate that fails on one
# third party's outage holds back every image this repo publishes; the tag
# build of v0.4.2-rc.3 failed twice on a 504 for the tarball while the image
# answered.
set -euo pipefail

: "${GITLEAKS_VERSION:?GITLEAKS_VERSION must name the release to install}"
GITLEAKS_DIR="${GITLEAKS_DIR:-/usr/local/bin}"

# Writes need root only where the destination is not writable.
if [ -w "$GITLEAKS_DIR" ]; then
  _as_root() { "$@"; }
else
  _as_root() { sudo "$@"; }
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

RELEASE_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
IMAGE="ghcr.io/gitleaks/gitleaks:v${GITLEAKS_VERSION}"

release_failed=0
# Download to the temp dir, never to GITLEAKS_DIR: a partial download must not
# be left where the next run would treat it as a binary.
if curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
    -o "$tmp/gitleaks.tar.gz" "$RELEASE_URL"; then
  if tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks; then
    _as_root install -m 0755 "$tmp/gitleaks" "$GITLEAKS_DIR/gitleaks"
  else
    release_failed=1
  fi
else
  release_failed=1
fi

if [ "$release_failed" -eq 1 ]; then
  echo "the gitleaks release download failed: $RELEASE_URL" >&2
  echo "using the image instead: $IMAGE" >&2

  if container="$(docker create "$IMAGE")"; then
    if docker cp "${container}:/usr/bin/gitleaks" "$tmp/gitleaks-from-image"; then
      _as_root install -m 0755 "$tmp/gitleaks-from-image" "$GITLEAKS_DIR/gitleaks"
      docker rm -f "$container" >/dev/null 2>&1 || true
    else
      docker rm -f "$container" >/dev/null 2>&1 || true
      echo "gitleaks could not be installed from either source:" >&2
      echo "  release: $RELEASE_URL" >&2
      echo "  image:   $IMAGE" >&2
      exit 1
    fi
  else
    echo "gitleaks could not be installed from either source:" >&2
    echo "  release: $RELEASE_URL" >&2
    echo "  image:   $IMAGE" >&2
    exit 1
  fi
fi

"$GITLEAKS_DIR/gitleaks" version
