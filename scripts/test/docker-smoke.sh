#!/usr/bin/env bash
# Checks how the `docker smoke start` step ends (scripts/docker-smoke.sh, which ci.yml runs and
# ci-local sources), against a fake `docker` (no daemon, no image): a healthy container passes; an
# unhealthy or exited one, an image with no HEALTHCHECK, and a `docker run` or `docker inspect`
# that fails each fail with their own exit code; and once the container may exist, it is always
# removed and its logs printed.
#   bash scripts/test/docker-smoke.sh
set -euo pipefail

smoke="$(cd "$(dirname "$0")/.." && pwd)/docker-smoke.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# The fake docker: FAKE_HC is the image's HEALTHCHECK test, FAKE_STATUS what inspect reports,
# FAKE_FAIL=run|inspect fails that subcommand with exit 7 (run after creating the container).
mkdir -p "$scratch/bin"
cat >"$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
state="$FAKE_STATE"
echo "$*" >>"$state/calls"
case "$1" in
  image) printf '%s\n' "${FAKE_HC-CMD-SHELL}" ;;
  rm) rm -f "$state/container" ;;
  run)
    touch "$state/container"
    if [[ "${FAKE_FAIL:-}" == run ]]; then echo "fake: run failed" >&2; exit 7; fi ;;
  inspect)
    if [[ "${FAKE_FAIL:-}" == inspect ]]; then echo "fake: inspect failed" >&2; exit 7; fi
    echo "${FAKE_STATUS:-healthy}" ;;
  logs) echo "fake container stdout"; echo "fake container stderr" >&2 ;;
esac
EOF
chmod +x "$scratch/bin/docker"

passed=0
failed=0
# expect <case> <exit code> <text the output must contain> <container: gone|never> [VAR=value...]
expect() {
  local name="$1" want="$2" text="$3" container="$4" output code=0 state
  shift 4
  state="$(mktemp -d "$scratch/state.XXXXXX")"
  output="$(env "$@" FAKE_STATE="$state" PATH="$scratch/bin:$PATH" \
    bash -c "set -euo pipefail; source '$smoke'; docker_smoke" 2>&1)" || code=$?
  local ok=1
  [[ $code -eq $want && "$output" == *"$text"* && ! -e "$state/container" ]] || ok=0
  if [[ "$container" == never ]] && grep -q '^run ' "$state/calls"; then ok=0; fi
  if [[ "$container" == gone && $want -ne 0 ]] && [[ "$output" != *"fake container stderr"* ]]; then ok=0; fi
  if [[ $ok -eq 1 ]]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: $name -> exit $code, wanted $want with \"$text\" (container $container); said: $output"
  fi
}

expect healthy 0 "container status: healthy" gone
expect unhealthy 1 "the container is unhealthy, not healthy" gone FAKE_STATUS=unhealthy
expect exited 1 "the container is exited, not healthy" gone FAKE_STATUS=exited
expect "no HEALTHCHECK" 1 "has no HEALTHCHECK (Dockerfile)" never FAKE_HC=
expect "HEALTHCHECK NONE" 1 "has no HEALTHCHECK (Dockerfile)" never FAKE_HC=NONE
expect "run fails" 7 "fake: run failed" gone FAKE_FAIL=run
expect "inspect fails" 7 "fake: inspect failed" gone FAKE_FAIL=inspect

# Run as a script, as ci.yml does: same step, same exit codes.
for want in 0 1; do
  state="$(mktemp -d "$scratch/state.XXXXXX")"
  code=0
  status=healthy
  [[ $want -eq 1 ]] && status=unhealthy
  FAKE_STATUS=$status FAKE_STATE="$state" PATH="$scratch/bin:$PATH" bash "$smoke" >/dev/null 2>&1 || code=$?
  if [[ $code -eq $want && ! -e "$state/container" ]]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: bash docker-smoke.sh with a $status container -> exit $code, wanted $want"
  fi
done

echo "docker-smoke: $passed passed, $failed failed"
[[ $failed -eq 0 ]]
