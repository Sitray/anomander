#!/usr/bin/env bash
# Checks the release notes scripts/release-notes.sh prints from a CHANGELOG: a section in the
# middle, the last section of the file, a missing or empty section, and the fixed block naming
# the builds and how to check their SHA-256.
#   bash scripts/test/release-notes.sh
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/release-notes.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

changelog="$scratch/CHANGELOG.md"
cat >"$changelog" <<'EOF'
# Changelog

## [Unreleased]

## [0.3.0] - 2026-12-01

### Added

## [0.2.0] - 2026-11-28

The second version.

### Added

- Downloads (see [`docs/windows-check.md`](docs/windows-check.md) and [Keep a Changelog](https://keepachangelog.com/)).

## [0.1.0] - 2026-11-21

The first version.

[0.1.0]: https://example.invalid/v0.1.0
EOF

passed=0
failed=0
check() {
  if eval "$2"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: $1; said: $output"
  fi
}
# run <release-notes.sh arguments...>: sets output and code.
run() {
  code=0
  output="$(bash "$script" "$@" 2>&1)" || code=$?
}

# A section in the middle: its body only, up to the next section, then the fixed block.
run 0.2.0 "$changelog"
check "0.2.0 exits 0" '[[ $code -eq 0 ]]'
check "0.2.0 starts with its body" '[[ "$output" == "The second version."* ]]'
check "0.2.0 has its entry" '[[ "$output" == *"- Downloads ("* ]]'
check "0.2.0 leaves out its heading" '[[ "$output" != *"## [0.2.0]"* ]]'
check "0.2.0 stops before 0.1.0" '[[ "$output" != *"The first version."* && "$output" != *"## [0.1.0]"* ]]'
check "0.2.0 points a relative link at its tag" \
  '[[ "$output" == *"(https://github.com/Sitray/anomander/blob/v0.2.0/docs/windows-check.md)"* ]]'
check "0.2.0 keeps an absolute link" '[[ "$output" == *"(https://keepachangelog.com/)"* ]]'
check "0.2.0 names the Mac build" '[[ "$output" == *"ANOMANDER-0.2.0-macos-arm64.zip"*"Apple silicon (arm64)"* ]]'
check "0.2.0 names the Windows build" '[[ "$output" == *"ANOMANDER_0.2.0_x64-setup.exe"*"64-bit (x64)"* ]]'
check "0.2.0 says there is no Intel Mac or Linux download" \
  '[[ "$output" == *"no download for an Intel Mac or for Linux: build the app from source, or run ANOMANDER with Docker"* ]]'
check "0.2.0 says how to check the hash on macOS" \
  '[[ "$output" == *"shasum -a 256 -c ANOMANDER-0.2.0-macos-arm64.zip.sha256"* ]]'
check "0.2.0 says how to check the hash on Windows" \
  '[[ "$output" == *"Get-FileHash ANOMANDER_0.2.0_x64-setup.exe -Algorithm SHA256"* ]]'

# The last section of the file: up to its end, without the link definitions.
run 0.1.0 "$changelog"
check "0.1.0 exits 0" '[[ $code -eq 0 ]]'
last=$'The first version.\n\n## Downloads'
check "0.1.0 has its body, then the fixed block" '[[ "$output" == "$last"* ]]'
check "0.1.0 leaves out the link definitions" '[[ "$output" != *"example.invalid"* ]]'

# The CHANGELOG from stdin, as scripts/release.sh passes the tag's.
code=0
output="$(bash "$script" 0.2.0 - <"$changelog" 2>&1)" || code=$?
check "stdin exits 0 with the section" '[[ $code -eq 0 && "$output" == "The second version."* ]]'

# A missing section fails.
run 0.9.0 "$changelog"
check "0.9.0 fails" '[[ $code -ne 0 ]]'
check "0.9.0 says why" '[[ "$output" == *"the CHANGELOG has no section for 0.9.0, or it is empty"* ]]'
check "0.9.0 prints no notes" '[[ "$output" != *"Downloads"* ]]'

# A section with headings only fails as empty.
run 0.3.0 "$changelog"
check "0.3.0 (headings only) fails" '[[ $code -ne 0 && "$output" == *"no section for 0.3.0, or it is empty"* ]]'

# A version that is not X.Y.Z, and a missing file.
run v0.2.0 "$changelog"
check "v0.2.0 fails" '[[ $code -ne 0 && "$output" == *"is not a version of the form X.Y.Z"* ]]'
run 0.2.0 "$scratch/none.md"
check "a missing file fails" '[[ $code -ne 0 && "$output" == *"none.md does not exist"* ]]'

# Links and code spans inside a section.
printf '## [1.0.0] - x\n\n- [d](docs/a.md#h) [x](#y) `## [z]`\n' >"$scratch/edge.md"
run 1.0.0 "$scratch/edge.md"
check "a relative link keeps its anchor" '[[ "$output" == *"(https://github.com/Sitray/anomander/blob/v1.0.0/docs/a.md#h)"* ]]'
check "an anchor-only link is left alone" '[[ "$output" == *"[x](#y)"* ]]'
check "a code span with ## [ does not end the section" '[[ "$output" == *"\`## [z]\`"* ]]'
# A CRLF CHANGELOG whose section has headings only.
printf '## [0.9.0] - y\r\n\r\n### Added\r\n\r\n## [0.8.0]\r\n' >"$scratch/crlf.md"
run 0.9.0 "$scratch/crlf.md"
check "a CRLF headings-only section fails" '[[ $code -ne 0 && "$output" == *"no section for 0.9.0, or it is empty"* ]]'

echo "release-notes: $passed passed, $failed failed"
[[ $failed -eq 0 ]]
