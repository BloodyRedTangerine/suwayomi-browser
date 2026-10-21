#!/usr/bin/env bash
# Builds both extension packages from a source tree, inside the pinned container.
#   SRC   the source tree (this repository), mounted read-only            default /src
#   WORK  scratch space; may be any path, nothing in the output depends on it   default /build
#   OUT   output directory                                               default /out
# Steps: clone the pinned upstreams -> npm ci -> Gradle host JAR -> WASM VM -> JRE class libraries and JS vendor
# bundles -> patched WebUI -> tests -> unpacked packages -> deterministic ZIPs -> hash manifests -> lint + tree check.
set -euo pipefail
SRC="${SRC:-/src}"; WORK="${WORK:-/build}"; OUT="${OUT:-/out}"
export TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8
export SOURCE_DATE_EPOCH="$(tr -d '[:space:]' < "$SRC/SOURCE_DATE_EPOCH")"
export npm_config_cache="$WORK/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export PNPM_HOME="$WORK/pnpm-home" npm_config_store_dir="$WORK/pnpm-store" CI=true
export GRADLE_USER_HOME="$WORK/gradle-home"
export BROWSER_BUILD_CACHE="$WORK/cache"
log() { printf '\n=== %s\n' "$*"; }
field() { node -e "const u=JSON.parse(require('fs').readFileSync('$SRC/UPSTREAM.json','utf8'));console.log($1)"; }
clone_pinned() { # repository revision directory
  mkdir -p "$3"; git -C "$3" init --quiet
  git -C "$3" remote add origin "$1"
  git -C "$3" fetch --quiet --depth 1 origin "$2"
  git -C "$3" checkout --quiet --detach FETCH_HEAD
  [ "$(git -C "$3" rev-parse HEAD)" = "$2" ] || { echo "revision mismatch for $1" >&2; exit 1; }
}

mkdir -p "$WORK" "$OUT"
[ -z "$(ls -A "$OUT" 2>/dev/null)" ] || { echo "Output directory $OUT is not empty" >&2; exit 1; }
SERVER="$WORK/Suwayomi-Server"; BROWSER="$SERVER/browser"; VERSION="$(node -p "require('$SRC/manifest.json').version")"

log "Pinned upstream: Suwayomi-Server (extension API sources read by Gradle)"
clone_pinned "$(field u.server.repository).git" "$(field u.server.revision)" "$SERVER"
log "Place the source tree at browser/ inside it"
mkdir -p "$BROWSER"
tar -C "$SRC" --exclude=./.git --exclude=./node_modules --exclude=./out --exclude=./runtime --exclude=./vendor --exclude=./ui --exclude=./jvm/build --exclude=./.cache -cf - . | tar -C "$BROWSER" -xf -
cd "$BROWSER"

log "npm ci"
npm ci
log "Gradle: extension host JAR (dependency verification on)"
( cd jvm && ./gradlew --no-daemon --console=plain browserJar writeRuntimeDependencyInventory )
log "b-jvm: clone, patch, compile to WebAssembly"
clone_pinned "$(field u.vm.repository).git" "$(field u.vm.revision)" "$WORK/b-jvm"
BROWSER_VM_SOURCE="$WORK/b-jvm" BROWSER_VM_BUILD_DIR="$WORK/b-jvm-build" BROWSER_BUILD_JOBS="$(nproc)" \
  bash -c 'source /opt/emsdk/emsdk_env.sh >/dev/null && export PATH=/opt/node/bin:$PATH EMSDK_NODE=/opt/node/bin/node && npm run build:vm'
log "JRE class libraries + JavaScript vendor bundles"
npm run prepare:runtime
log "Suwayomi-WebUI: clone, patch, build"
clone_pinned "$(field u.webui.repository).git" "$(field u.webui.revision)" "$WORK/webui"
BROWSER_RELEASE_EDITS=1 SUWAYOMI_WEBUI_SOURCE="$WORK/webui" npm run build:webui
log "Tests (synthetic suite; WebUI call-site audits use the patched checkout)"
SUWAYOMI_WEBUI_SOURCE="$WORK/webui" npm test
log "Packages"
node scripts/package-extension.mjs "$OUT/firefox" --target=firefox
node scripts/package-extension.mjs "$OUT/chrome" --target=chrome
node scripts/zip-package.mjs "$OUT/firefox" "$OUT/suwayomi-browser-firefox-$VERSION.zip"
node scripts/zip-package.mjs "$OUT/chrome" "$OUT/suwayomi-browser-$VERSION.zip"
log "Hash manifests"
( cd "$OUT/firefox" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$OUT/files-firefox.sha256" )
( cd "$OUT/chrome" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$OUT/files-chrome.sha256" )
( cd "$OUT" && sha256sum "suwayomi-browser-firefox-$VERSION.zip" "suwayomi-browser-$VERSION.zip" > SHA256SUMS )
log "Checks on the exact outputs"
if [ -f "$BROWSER/check-public-tree.mjs" ]; then node "$BROWSER/check-public-tree.mjs" --package "$OUT/firefox" --package "$OUT/chrome"; fi
mkdir -p "$OUT/reports"
web-ext lint --source-dir "$OUT/firefox" --output text > "$OUT/reports/web-ext-lint.txt" 2>&1 || true
web-ext lint --source-dir "$OUT/firefox" --output json > "$OUT/reports/web-ext-lint.json" 2>&1 || true
{ echo "node $(node --version) npm $(npm --version) pnpm $(pnpm --version) web-ext $(web-ext --version)"; cmake --version | head -1; echo "ninja $(ninja --version)"; java -version 2>&1 | head -1; "$EMSDK/upstream/emscripten/emcc" --version | head -1; ( cd jvm && ./gradlew --no-daemon --version | grep '^Gradle' ); } > "$OUT/reports/tool-versions.txt" 2>&1 || true
if [ -n "${HOST_UID:-}" ]; then chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$OUT"; fi
log "Done: $OUT"
cat "$OUT/SHA256SUMS"
