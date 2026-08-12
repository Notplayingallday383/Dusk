#!/usr/bin/env pwsh
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

$ErrorActionPreference = "Stop"

$REPO_ROOT = $PSScriptRoot
$VENDOR = Join-Path $REPO_ROOT "vendor"
$NOVA_REPO_URL = if ($env:NOVA_REPO_URL) { $env:NOVA_REPO_URL } else { "https://github.com/Night-N3twork/Nova.git" }
$NOVA_REF = if ($env:NOVA_REF) { $env:NOVA_REF } else { "main" }

if (-not (Test-Path $VENDOR)) {
    New-Item -ItemType Directory -Path $VENDOR | Out-Null
}

# ---- Nova ----
$NovaGitDir = Join-Path $VENDOR "nova\.git"
if (-not (Test-Path $NovaGitDir)) {
    Write-Host "[setup] Cloning Nova from $NOVA_REPO_URL"
    git clone --depth 1 --branch "$NOVA_REF" "$NOVA_REPO_URL" (Join-Path $VENDOR "nova")
} else {
    Write-Host "[setup] Nova already vendored at $VENDOR/nova; pulling latest on $NOVA_REF"
    Push-Location (Join-Path $VENDOR "nova")
    try {
        git fetch --depth 1 origin "$NOVA_REF"
        git reset --hard "origin/$NOVA_REF"
    } finally {
        Pop-Location
    }
}

# Verify prerequisites.
if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    Write-Error "[setup] ERROR: wasm-pack not found. Install via https://rustwasm.github.io/wasm-pack/installer/"
    exit 1
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error "[setup] ERROR: cargo not found. Install rustup: https://rustup.rs/"
    exit 1
}

# ---- Build nova-wasm ----
Write-Host "[setup] Building nova-wasm (this may take several minutes on first run)"
Push-Location (Join-Path $VENDOR "nova")
try {
    wasm-pack build --target web --release nova-wasm
} finally {
    Pop-Location
}

# ---- Publish the built pkg where DuskJS's package.json expects it ----
$NovaWasmDest = Join-Path $VENDOR "nova-wasm"
if (Test-Path $NovaWasmDest) {
    Remove-Item -Recurse -Force $NovaWasmDest
}
$NovaWasmPkg = Join-Path $VENDOR "nova\nova-wasm\pkg"
Copy-Item -Recurse $NovaWasmPkg $NovaWasmDest
Write-Host "[setup] nova-wasm vendored at $VENDOR/nova-wasm"

# ---- npm install ----
Write-Host "[setup] Running npm install"
Push-Location $REPO_ROOT
try {
    npm install
} finally {
    Pop-Location
}

Write-Host "[setup] Done. DuskJS is ready. Try:  npm run dev"