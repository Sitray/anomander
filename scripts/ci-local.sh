#!/usr/bin/env bash
# Runs locally the checks of .github/workflows/ci.yml that this machine can run: the `check` job
# (TypeScript and the Rust shell), the Mac app smoke build, and the daemon image with its smoke
# start when Docker is running. The Windows and Linux jobs cannot run here and are reported as
# skipped.
# Usage: scripts/ci-local.sh [--skip-build]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

skip_build=false
[[ "${1:-}" == "--skip-build" ]] && skip_build=true

step() { printf '\n==> %s\n' "$*"; }

# The `docker smoke start` step of ci.yml: the image starts with a throwaway local token as its
# only front door (no model, no Telegram, no published port) and its HEALTHCHECK turns healthy.
docker_smoke() {
  local token status=starting
  token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  docker rm --force anomander-smoke >/dev/null 2>&1 || true
  docker run --detach --name anomander-smoke --health-interval=2s \
    --env ANOMANDER_LOCAL_TOKEN="$token" anomander-daemon:ci >/dev/null
  for _ in $(seq 1 30); do
    status="$(docker inspect --format '{{if .State.Running}}{{.State.Health.Status}}{{else}}exited{{end}}' anomander-smoke)"
    [[ "$status" == starting ]] || break
    sleep 2
  done
  docker logs anomander-smoke
  docker rm --force anomander-smoke >/dev/null
  echo "container status: $status"
  [[ "$status" == healthy ]]
}

wanted="$(cat .node-version)"
have="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$have" == "$wanted" ]] || echo "warning: node $have here, CI uses $wanted (.node-version)"

step "pnpm install --frozen-lockfile"; pnpm install --frozen-lockfile
step "pnpm biome ci ."; pnpm biome ci .
step "pnpm -r typecheck"; pnpm -r typecheck
step "pnpm test"; pnpm test
step "pnpm audit --audit-level high"; pnpm audit --audit-level high
step "release script arguments"; bash scripts/test/release-args.sh

cd apps/desktop/src-tauri
step "cargo fmt --check"; cargo fmt --check
step "cargo clippy --all-targets -- -D warnings"; cargo clippy --all-targets -- -D warnings
step "cargo test"; cargo test
# ci.yml installs cargo-audit; here it runs only if it is already installed.
if command -v cargo-audit >/dev/null 2>&1; then
  step "cargo audit"; cargo audit
else
  echo "skipped: cargo audit (cargo-audit is not installed; the CI audit job runs it)"
fi
# The msrv job: the declared rust-version, here only if that toolchain is already installed.
msrv="$(sed -n 's/^rust-version = "\(.*\)"$/\1/p' Cargo.toml)"
if rustup toolchain list | grep -q "^$msrv[-.]"; then
  step "cargo +$msrv check --locked --all-targets"; cargo +"$msrv" check --locked --all-targets
else
  echo "skipped: cargo check on rust-version $msrv (install it with: rustup toolchain install $msrv --profile minimal)"
fi
cd "$root"

if $skip_build; then
  echo "skipped: tauri build, docker build, docker smoke start (--skip-build)"
else
  step "tauri build (debug, unsigned)"
  (cd apps/desktop && pnpm tauri build --debug --ci)
  if docker info >/dev/null 2>&1; then
    step "docker build"; docker build --tag anomander-daemon:ci .
    step "docker smoke start (healthy)"; docker_smoke
  else
    echo "skipped: docker build, docker smoke start (Docker is not running)"
  fi
fi

echo
echo "skipped: check on windows-latest, tauri-build-windows (need Windows), check-linux (needs Linux)"
echo "ci-local: all checks passed"
