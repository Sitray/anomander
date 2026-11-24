#!/usr/bin/env bash
# Runs locally the checks of .github/workflows/ci.yml that this machine can run: the `check` job
# (TypeScript and the Rust shell), the Mac app smoke build, and the daemon image when Docker is
# running. The Windows jobs cannot run here and are reported as skipped.
# Usage: scripts/ci-local.sh [--skip-build]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

skip_build=false
[[ "${1:-}" == "--skip-build" ]] && skip_build=true

step() { printf '\n==> %s\n' "$*"; }

wanted="$(cat .node-version)"
have="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$have" == "$wanted" ]] || echo "warning: node $have here, CI uses $wanted (.node-version)"

step "pnpm install --frozen-lockfile"; pnpm install --frozen-lockfile
step "pnpm biome ci ."; pnpm biome ci .
step "pnpm -r typecheck"; pnpm -r typecheck
step "pnpm test"; pnpm test

cd apps/desktop/src-tauri
step "cargo fmt --check"; cargo fmt --check
step "cargo clippy --all-targets -- -D warnings"; cargo clippy --all-targets -- -D warnings
step "cargo test"; cargo test
cd "$root"

if $skip_build; then
  echo "skipped: tauri build, docker build (--skip-build)"
else
  step "tauri build (debug, unsigned)"
  (cd apps/desktop && pnpm tauri build --debug --ci)
  if docker info >/dev/null 2>&1; then
    step "docker build"; docker build --tag anomander-daemon:ci .
  else
    echo "skipped: docker build (Docker is not running)"
  fi
fi

echo
echo "skipped: check on windows-latest, tauri-build-windows (need Windows)"
echo "ci-local: all checks passed"
