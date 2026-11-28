#!/usr/bin/env bash
# Prints the GitHub release notes of a version: its CHANGELOG section, then which builds the
# release has and how to check them. scripts/release.sh and .github/workflows/release.yml both
# use it, so a release never goes out without its section.
#
#   scripts/release-notes.sh X.Y.Z [CHANGELOG]
#
# CHANGELOG is the file to read (CHANGELOG.md at the repository root by default; `-` reads
# stdin). The section is everything under `## [X.Y.Z]` up to the next `## [`, without that
# heading. Links to files of the repository point to them at the tag `vX.Y.Z`, as relative ones
# do not resolve on a release page. Fails when the section is missing or has nothing but headings.
set -euo pipefail

fail() {
  echo "release-notes: $*" >&2
  exit 1
}

usage="usage: scripts/release-notes.sh X.Y.Z [CHANGELOG]"
[[ $# -ge 1 && $# -le 2 ]] || fail "$usage"
version="$1"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$version' is not a version of the form X.Y.Z"
changelog="${2:-$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md}"
if [[ "$changelog" == - ]]; then
  text="$(cat)"
else
  [[ -f "$changelog" ]] || fail "$changelog does not exist"
  text="$(cat "$changelog")"
fi

section="$(awk -v heading="## [$version]" '
  index($0, "## [") == 1 { if (inside) exit; if (index($0, heading) == 1) { inside = 1; next } }
  inside && !/^\[[^]]+\]: / { print }
' <<<"$text")"

grep -q '^[[:space:]]*[^#[:space:]]' <<<"$section" ||
  fail "the CHANGELOG has no section for $version, or it is empty (add \"## [$version] - <date>\" with its changes)"

# Trim the blank lines around the section, and point relative links at the tag.
repo="https://github.com/Sitray/anomander/blob/v$version"
sed -E -e "s,\]\(([^)#:/][^):]*)\),](${repo}/\1),g" <<<"$section" |
  awk 'NF { for (; blank > 0; blank--) print ""; print; started = 1; next } started { blank++ }'

# The builds and their checks say what README.md, "Download", says: change both together.
zip="ANOMANDER-$version-macos-arm64.zip"
exe="ANOMANDER_${version}_x64-setup.exe"
cat <<EOF

## Downloads

| File | For |
| --- | --- |
| \`$zip\` | A Mac with Apple silicon (arm64) |
| \`$exe\` | Windows 10 or 11, 64-bit (x64) |

There is no download for an Intel Mac or for Linux: build the app from source, or run ANOMANDER with Docker (see the README).

The builds are unsigned: the README, "Download", says how to open them the first time.

Each file has its SHA-256 in a \`.sha256\` file beside it. To check a download:

- macOS, in the folder of both files: \`shasum -a 256 -c $zip.sha256\` prints \`OK\`.
- Windows, in PowerShell: \`Get-FileHash $exe -Algorithm SHA256\` prints the same hash as \`$exe.sha256\`, in capitals.
EOF
