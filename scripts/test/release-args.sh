#!/usr/bin/env bash
# Checks how scripts/release.sh refuses a tag before it builds anything: no tag, a malformed tag,
# a tag missing here or on origin, or at another commit there, a version the app does not have,
# and a version the CHANGELOG has no section for. Each case runs the script, copied into a throwaway repository with its own origin, in
# `--check` mode, and expects its exit code and message.
#   bash scripts/test/release-args.sh
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/release.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

git_q() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false -c tag.gpgsign=false "$@" >/dev/null 2>&1; }

# A repository with the three files holding the app's version, all at 0.1.0, a CHANGELOG with its
# section, and a bare origin.
git init -q --bare "$scratch/origin.git"
repo="$scratch/repo"
git init -q "$repo"
mkdir -p "$repo/scripts" "$repo/apps/desktop/src-tauri"
cp "$script" "$repo/scripts/release.sh"
cp "$(dirname "$script")/release-notes.sh" "$repo/scripts/release-notes.sh"
printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-21\n\n- The first version.\n' >"$repo/CHANGELOG.md"
touch "$repo/scripts/stage-daemon.mjs"
echo '{ "productName": "ANOMANDER", "version": "0.1.0" }' >"$repo/apps/desktop/src-tauri/tauri.conf.json"
echo '{ "name": "@anomander/desktop", "version": "0.1.0" }' >"$repo/apps/desktop/package.json"
printf '[package]\nname = "anomander-desktop"\nversion = "0.1.0"\n' >"$repo/apps/desktop/src-tauri/Cargo.toml"
git_q -C "$repo" add -A
git_q -C "$repo" commit -m base
git_q -C "$repo" remote add origin "$scratch/origin.git"
git_q -C "$repo" push origin HEAD:refs/heads/main

passed=0
failed=0
# expect <exit: 0|fail> <text the output must contain> <release.sh arguments...>
expect() {
  local want="$1" text="$2" output code=0
  shift 2
  output="$(cd "$repo" && bash scripts/release.sh "$@" 2>&1)" || code=$?
  if { [[ "$want" == 0 && $code -eq 0 ]] || [[ "$want" == fail && $code -ne 0 ]]; } &&
    [[ "$output" == *"$text"* ]]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: release.sh $* -> exit $code, wanted $want with \"$text\"; said: $output"
  fi
}

expect fail "no tag given" --check
expect fail "no tag given"
expect fail "'0.1.0' is not a release tag of the form vX.Y.Z" --check 0.1.0
expect fail "'v0.1' is not a release tag of the form vX.Y.Z" --check v0.1
expect fail "'v0.1.0-rc.1' is not a release tag of the form vX.Y.Z" --check v0.1.0-rc.1
expect fail "unknown option --force" --force v0.1.0
expect fail "one tag only" --check v0.1.0 v0.1.1
expect fail "tag v0.1.0 does not exist in this repository" --check v0.1.0

git_q -C "$repo" tag -a v0.1.0 -m v0.1.0
expect fail "tag v0.1.0 is not on origin" --check v0.1.0

git_q -C "$repo" push origin v0.1.0
expect 0 "v0.1.0 (" --check v0.1.0

# The version of the tag is not the app's.
git_q -C "$repo" tag v0.2.0
git_q -C "$repo" push origin v0.2.0
expect fail "tag v0.2.0 is version 0.2.0 but apps/desktop/src-tauri/tauri.conf.json at that tag says 0.1.0" --check v0.2.0
expect fail "tauri.conf.json at that tag says 0.1.0" --dry-run v0.2.0

# A tag from before the staged daemon, at the right version.
set_version() {
  echo "{ \"productName\": \"ANOMANDER\", \"version\": \"$1\" }" >"$repo/apps/desktop/src-tauri/tauri.conf.json"
  echo "{ \"name\": \"@anomander/desktop\", \"version\": \"$1\" }" >"$repo/apps/desktop/package.json"
  printf '[package]\nname = "anomander-desktop"\nversion = "%s"\n' "$1" >"$repo/apps/desktop/src-tauri/Cargo.toml"
}
set_version 0.1.1
git_q -C "$repo" rm scripts/stage-daemon.mjs
git_q -C "$repo" commit -am old
git_q -C "$repo" tag v0.1.1
git_q -C "$repo" push origin v0.1.1
expect fail "tag v0.1.1 predates scripts/stage-daemon.mjs" --check v0.1.1
set_version 0.1.0
touch "$repo/scripts/stage-daemon.mjs"
git_q -C "$repo" add -A
git_q -C "$repo" commit -m back

# tauri.conf.json bumped, package.json forgotten.
echo '{ "productName": "ANOMANDER", "version": "0.3.0" }' >"$repo/apps/desktop/src-tauri/tauri.conf.json"
git_q -C "$repo" commit -am bump
git_q -C "$repo" tag v0.3.0
git_q -C "$repo" push origin v0.3.0
expect fail "apps/desktop/package.json at that tag says 0.1.0" --check v0.3.0

# The version bumped everywhere, but the CHANGELOG has no section for it.
set_version 0.4.0
git_q -C "$repo" commit -am bump-all
git_q -C "$repo" tag v0.4.0
git_q -C "$repo" push origin v0.4.0
expect fail "tag v0.4.0 has no CHANGELOG section for 0.4.0" --check v0.4.0
expect fail "the CHANGELOG has no section for 0.4.0" --check v0.4.0

# The tag moved here after it was pushed.
git_q -C "$repo" tag -f -a v0.1.0 -m moved HEAD
expect fail "tag v0.1.0 is at" --check v0.1.0

echo "release-args: $passed passed, $failed failed"
[[ $failed -eq 0 ]]
