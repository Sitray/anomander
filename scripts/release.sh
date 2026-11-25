#!/usr/bin/env bash
# Builds the macOS release of a tag and adds it to that tag's GitHub release (B11).
#
#   scripts/release.sh [--dry-run | --check] vX.Y.Z
#
# The tag must exist here and on origin, at the same commit, and its version must be the app's:
# `version` in apps/desktop/src-tauri/tauri.conf.json (the one the app and the installers show),
# equal to apps/desktop/package.json and apps/desktop/src-tauri/Cargo.toml at that tag.
#
# From a clean, temporary worktree of the tag: `pnpm install --frozen-lockfile`, the daemon and a
# pinned Node staged as the app's resources (scripts/stage-daemon.mjs), a release `.app` for Apple
# silicon, signed ad hoc from the inside out (no Apple identity, no notarization), packed as
# `ANOMANDER-<version>-macos-arm64.zip` with its SHA-256 beside it. Both land in
# apps/desktop/src-tauri/target/release-artifacts/<tag>/ and are uploaded with `gh`: to a new
# draft release when the tag has none, replacing files of the same name otherwise.
# .github/workflows/release.yml adds the Windows installer to the same release.
#
#   --dry-run   everything except the upload, which is printed instead
#   --check     only the checks of the tag and its version, then stop
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

fail() {
  echo "release: $*" >&2
  exit 1
}

usage="usage: scripts/release.sh [--dry-run | --check] vX.Y.Z"
mode=upload
tag=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) mode=dry-run ;;
    --check) mode=check ;;
    -*) fail "unknown option $arg ($usage)" ;;
    *)
      [[ -z "$tag" ]] || fail "one tag only ($usage)"
      tag="$arg"
      ;;
  esac
done

[[ -n "$tag" ]] || fail "no tag given ($usage)"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || fail "'$tag' is not a release tag of the form vX.Y.Z"
version="${BASH_REMATCH[1]}"

# The tag, here and on origin, at the same commit.
commit="$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}")" ||
  fail "tag $tag does not exist in this repository (create it with: git tag -a $tag -m $tag)"
remote="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")" ||
  fail "cannot read the tags of origin"
[[ -n "$remote" ]] || fail "tag $tag is not on origin (push it with: git push origin $tag)"
# An annotated tag is listed twice; the `^{}` line names its commit.
remote_commit="$(awk -v peeled="refs/tags/$tag^{}" '$2 == peeled { print $1 }' <<<"$remote")"
[[ -n "$remote_commit" ]] || remote_commit="$(awk 'NR == 1 { print $1 }' <<<"$remote")"
[[ "$remote_commit" == "$commit" ]] ||
  fail "tag $tag is at $commit here but at $remote_commit on origin"

# The app's version at that tag.
json_version() {
  git show "$tag:$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
}
app_version="$(json_version apps/desktop/src-tauri/tauri.conf.json)" ||
  fail "cannot read apps/desktop/src-tauri/tauri.conf.json at $tag"
[[ "$app_version" == "$version" ]] ||
  fail "tag $tag is version $version but apps/desktop/src-tauri/tauri.conf.json at that tag says $app_version; bump the version, commit, and tag that commit"
package_version="$(json_version apps/desktop/package.json)" ||
  fail "cannot read apps/desktop/package.json at $tag"
[[ "$package_version" == "$version" ]] ||
  fail "tag $tag is version $version but apps/desktop/package.json at that tag says $package_version"
cargo_version="$(git show "$tag:apps/desktop/src-tauri/Cargo.toml" | sed -n 's/^version = "\(.*\)"$/\1/p' | head -n 1)" ||
  fail "cannot read apps/desktop/src-tauri/Cargo.toml at $tag"
[[ "$cargo_version" == "$version" ]] ||
  fail "tag $tag is version $version but apps/desktop/src-tauri/Cargo.toml at that tag says $cargo_version"

git cat-file -e "$tag:scripts/stage-daemon.mjs" 2>/dev/null ||
  fail "tag $tag predates scripts/stage-daemon.mjs, so its app cannot carry the daemon; release a later tag"

if [[ "$mode" == check ]]; then
  echo "release: $tag ($commit) is version $version here and on origin"
  exit 0
fi

[[ "$(uname -s)-$(uname -m)" == Darwin-arm64 ]] || fail "the macOS release builds on a Mac with Apple silicon"
for tool in pnpm codesign ditto shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done
if [[ "$mode" == upload ]]; then
  command -v gh >/dev/null 2>&1 || fail "gh is not installed"
  gh auth status >/dev/null 2>&1 || fail "gh is not logged in (gh auth login)"
fi

# A clean worktree of the tag, removed on exit whatever happens.
scratch="$(mktemp -d)"
src="$scratch/src"
cleanup() {
  git -C "$root" worktree remove --force "$src" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
git worktree add --detach "$src" "$tag" >/dev/null

echo "==> pnpm install --frozen-lockfile"
pnpm --dir "$src" install --frozen-lockfile
echo "==> stage the daemon and Node"
node "$src/scripts/stage-daemon.mjs" darwin-arm64
echo "==> tauri build (release, .app)"
# No signing identity: the app is signed ad hoc below, after its nested code.
(cd "$src/apps/desktop" &&
  env -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE \
    pnpm tauri build --ci --bundles app --config src-tauri/tauri.release.conf.json)

target_dir="${CARGO_TARGET_DIR:-$src/apps/desktop/src-tauri/target}"
app="$target_dir/release/bundle/macos/ANOMANDER.app"
[[ -d "$app" ]] || fail "the build made no $app"

echo "==> sign ad hoc, inside out"
xattr -cr "$app"
# Every Mach-O file of the bundle (the bundled node, each `.node` addon, any other executable),
# deepest first; then the bundle itself, which seals them and signs its main executable. No
# `--deep`: each nested binary is signed on its own.
nested=()
while IFS= read -r file; do
  if [[ "$(file -b "$file")" == Mach-O* ]]; then nested+=("$file"); fi
done < <(find "$app/Contents" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) \
  ! -path "$app/Contents/MacOS/*" | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
[[ ${#nested[@]} -gt 0 ]] || fail "no nested binary found in $app (is the daemon staged?)"
for file in "${nested[@]}"; do
  codesign --force --sign - "$file"
done
codesign --force --sign - "$app"
echo "signed ${#nested[@]} nested binaries and the app"
codesign --verify --strict --verbose=2 "$app"

out="$root/apps/desktop/src-tauri/target/release-artifacts/$tag"
zip_name="ANOMANDER-$version-macos-arm64.zip"
mkdir -p "$out"
rm -f "$out/$zip_name" "$out/$zip_name.sha256"
ditto -c -k --keepParent "$app" "$out/$zip_name"
(cd "$out" && shasum -a 256 "$zip_name" >"$zip_name.sha256")
echo "==> $out/$zip_name"
cat "$out/$zip_name.sha256"

files=("$out/$zip_name" "$out/$zip_name.sha256")
if gh release view "$tag" >/dev/null 2>&1; then
  upload=(gh release upload "$tag" "${files[@]}" --clobber)
else
  upload=(gh release create "$tag" "${files[@]}" --draft --verify-tag --title "ANOMANDER $version"
    --notes "Unsigned builds of ANOMANDER $version. How to open them the first time: see the README, \"Download\".")
fi
if [[ "$mode" == dry-run ]]; then
  printf 'release: dry run, not uploading:'
  printf ' %q' "${upload[@]}"
  printf '\n'
else
  "${upload[@]}"
  echo "release: $tag has $zip_name; publish the draft once the Windows installer is there"
fi
