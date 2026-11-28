#!/usr/bin/env bash
# The `docker smoke start` step, shared by .github/workflows/ci.yml and scripts/ci-local.sh: the
# anomander-daemon:ci image starts with a throwaway local token as its only front door (no model,
# no Telegram, no published port) and its HEALTHCHECK turns healthy. Run it, or source it for
# `docker_smoke` (scripts/test/docker-smoke.sh does, against a fake docker).
#   bash scripts/docker-smoke.sh

# Prints the smoke container's logs and removes it: on success, and from the EXIT trap on any
# failure of `docker_smoke` once the container may exist.
smoke_cleanup() {
  docker logs anomander-smoke || true
  docker rm --force anomander-smoke >/dev/null 2>&1 || true
}

docker_smoke() {
  local token check status=starting
  # Without a HEALTHCHECK the container never reports a health, so say so instead of waiting.
  check="$(docker image inspect --format '{{with .Config.Healthcheck}}{{index .Test 0}}{{end}}' anomander-daemon:ci)"
  if [[ -z "$check" || "$check" == NONE ]]; then
    echo "docker smoke start: anomander-daemon:ci has no HEALTHCHECK (Dockerfile), so it can never turn healthy" >&2
    return 1
  fi
  token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  docker rm --force anomander-smoke >/dev/null 2>&1 || true
  trap smoke_cleanup EXIT
  docker run --detach --name anomander-smoke --health-interval=2s \
    --env ANOMANDER_LOCAL_TOKEN="$token" anomander-daemon:ci >/dev/null
  for _ in $(seq 1 30); do
    status="$(docker inspect --format '{{if .State.Running}}{{with .State.Health}}{{.Status}}{{else}}without health{{end}}{{else}}exited{{end}}' anomander-smoke)"
    [[ "$status" == starting ]] || break
    sleep 2
  done
  trap - EXIT
  smoke_cleanup
  echo "container status: $status"
  if [[ "$status" != healthy ]]; then
    echo "docker smoke start: the container is $status, not healthy" >&2
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  docker_smoke
fi
