#!/usr/bin/env bash
# DuskJS setup — clone and build sibling projects DuskJS depends on locally.
#
# DuskJS depends on `nova-wasm` (Rust wisp client compiled to WebAssembly).
# This script vendors Nova at ./vendor/nova/ and builds its wasm package
# into ./vendor/nova-wasm/ so `npm install` can resolve the local file: dep.
#
# Requirements:
#   - git
#   - rust (via rustup) with the wasm32-unknown-unknown target
#   - wasm-pack (https://rustwasm.github.io/wasm-pack/installer/)
#   - node + npm

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$REPO_ROOT/vendor"
NOVA_REPO_URL="${NOVA_REPO_URL:-https://github.com/nightnetwork/nova.git}"
NOVA_REF="${NOVA_REF:-main}"

mkdir -p "$VENDOR"

# ---- Nova ----
if [ ! -d "$VENDOR/nova/.git" ]; then
  echo "[setup] Cloning Nova from $NOVA_REPO_URL"
  git clone --depth 1 --branch "$NOVA_REF" "$NOVA_REPO_URL" "$VENDOR/nova"
else
  echo "[setup] Nova already vendored at $VENDOR/nova; pulling latest on $NOVA_REF"
  (cd "$VENDOR/nova" && git fetch --depth 1 origin "$NOVA_REF" && git reset --hard "origin/$NOVA_REF")
fi

# Verify prerequisites.
command -v wasm-pack >/dev/null 2>&1 || {
  echo "[setup] ERROR: wasm-pack not found. Install via https://rustwasm.github.io/wasm-pack/installer/" >&2
  exit 1
}
command -v cargo >/dev/null 2>&1 || {
  echo "[setup] ERROR: cargo not found. Install rustup: https://rustup.rs/" >&2
  exit 1
}

# ---- Build nova-wasm ----
echo "[setup] Building nova-wasm (this may take several minutes on first run)"
(
  cd "$VENDOR/nova"
  wasm-pack build --target web --release nova-wasm
)

# ---- Publish the built pkg where DuskJS's package.json expects it ----
rm -rf "$VENDOR/nova-wasm"
cp -r "$VENDOR/nova/nova-wasm/pkg" "$VENDOR/nova-wasm"
echo "[setup] nova-wasm vendored at $VENDOR/nova-wasm"

# ---- npm install ----
echo "[setup] Running npm install"
(cd "$REPO_ROOT" && npm install)

echo "[setup] Done. DuskJS is ready. Try:  npm run dev"
