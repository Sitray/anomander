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

# The `docker smoke start` step, as ci.yml runs it.
source "$root/scripts/docker-smoke.sh"

wanted="$(cat .node-version)"
# Run on the Node major CI uses when Homebrew has it (`brew install node@<major>`), ahead of the default one.
for dir in "/opt/homebrew/opt/node@$wanted/bin" "/usr/local/opt/node@$wanted/bin"; do
  if [[ -x "$dir/node" ]]; then export PATH="$dir:$PATH"; break; fi
done
have="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$have" == "$wanted" ]] || echo "warning: node $have here, CI uses $wanted (.node-version)"

step "pnpm install --frozen-lockfile"; pnpm install --frozen-lockfile
step "pnpm biome ci ."; pnpm biome ci .
step "pnpm -r typecheck"; pnpm -r typecheck
step "pnpm test"; pnpm test
step "pnpm audit --audit-level high"; pnpm audit --audit-level high
step "release script arguments"; bash scripts/test/release-args.sh
step "docker smoke step ends"; bash scripts/test/docker-smoke.sh

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
# `cargo +1.90` runs only the toolchain named `1.90-<host>`; one installed as `1.90.0-<host>` is
# another name, so only the exact name counts.
msrv="$(sed -n 's/^rust-version = "\(.*\)"$/\1/p' Cargo.toml)"
if rustup toolchain list | awk -v name="$msrv-" 'index($1, name) == 1 { found = 1 } END { exit !found }'; then
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
