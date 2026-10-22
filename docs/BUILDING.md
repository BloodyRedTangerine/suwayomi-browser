# Building

## Supported environment

- Ubuntu 24.04 LTS, **x86_64** (the Corretto class libraries and the Emscripten toolchain used by the scripts are x86_64
  builds; on arm64 use an x86_64 container, which is slow under emulation).
- Docker, and network access to: github.com (upstream clones), registry.npmjs.org, repo.maven.apache.org,
  plugins.gradle.org, services.gradle.org, jitpack.io and raw.githubusercontent.com (Gradle dependencies), corretto.aws,
  nodejs.org, storage.googleapis.com (Emscripten toolchain archives) and Docker Hub.
- About 15 GB free disk, 8 GB RAM, 20-40 minutes.

## One command

```sh
docker/build-in-docker.sh ./out
```

This builds `docker/Dockerfile` (tool versions below, all pinned by version and SHA-256 or Git commit) and runs
`docker/build.sh` with the source mounted read-only. Output in `./out`:

| Path | Content |
|---|---|
| `firefox/`, `chrome/` | The unpacked extension packages. |
| `suwayomi-browser-firefox-0.3.6.zip`, `suwayomi-browser-0.3.6.zip` | The deterministic release ZIPs (the Firefox one is the AMO upload). |
| `SHA256SUMS`, `files-firefox.sha256`, `files-chrome.sha256` | ZIP hashes and sorted per-file hashes of both packages. |
| `reports/` | `web-ext lint` output (text and JSON) and the tool versions used. |

## Pinned toolchain (docker/Dockerfile)

| Tool | Version | Pin |
|---|---|---|
| Base image | ubuntu:24.04 (linux/amd64) | image digest |
| Node.js / npm | 24.21.0 / bundled | SHA-256 of the tarball |
| pnpm | 11.1.2 (the WebUI `packageManager`) | exact version |
| JDK running Gradle | Eclipse Temurin 21.0.12.1+1 | SHA-256 of the tarball |
| Gradle | 9.8.1 (wrapper in `jvm/`) | `distributionSha256Sum`, wrapper JAR SHA-256 in this file, `jvm/gradle/verification-metadata.xml` for every dependency |
| Emscripten | 4.0.2 | emsdk commit 539e4044b78c |
| CMake / Ninja | 3.31.6 / 1.13.2 | SHA-256 of the archives |
| web-ext (lint only) | 10.5.0 | exact version |
| Corretto 23.0.2.7.1 class libraries | fetched by `scripts/prepare-openjdk.mjs` | SHA-256 in `UPSTREAM.json` |

Gradle wrapper JAR SHA-256: `3b8a25775a69158b5ad2b1d17a80a88dc7b40a352a73eb27d06c612a7ce68e98`.

## What the build does

`docker/build.sh` runs these steps (you can run them by hand in an equivalent environment):

1. Clone Suwayomi-Server at the revision in `UPSTREAM.json` into `<work>/Suwayomi-Server` and place this tree at
   `<work>/Suwayomi-Server/browser`. **Layout requirement:** `jvm/build.gradle.kts` reads the unmodified Tachiyomi/Mihon extension
   API sources from `../../server/src/main/kotlin` and `../../AndroidCompat/src/main/java`.
2. `npm ci` (lockfile pinned).
3. `cd jvm && ./gradlew browserJar writeRuntimeDependencyInventory` builds `runtime/extension-host.jar` (dependency
   verification on; only the first of these tasks is needed for the package, the second records the dependency list).
4. `npm run build:vm`: clones b-jvm at the pinned revision, applies `jvm/vm-patches/extension-runtime.patch`, compiles to
   WebAssembly with Emscripten (`-ffile-prefix-map` keeps build paths out of the output) and bundles the JavaScript wrapper.
5. `npm run prepare:runtime`: downloads the pinned Corretto build and links a JRE image. Its `jdk23/lib/modules` JIMAGE is
   shared by the bootstrap loader and Java's `jrt:/` provider; no duplicate `jdk23.jar` is shipped. The full selected locale
   data and module metadata remain. The step also bundles fflate and QuickJS.
6. `npm run build:webui`: clones Suwayomi-WebUI at the pinned revision, applies `webui/browser-local.patch`, installs with
   `pnpm install --frozen-lockfile` and builds with Vite. With `BROWSER_RELEASE_EDITS=1` (set by `docker/build.sh`) it also empties
   the upstream list of third-party site names that the WebUI uses to guess an entry's type from its source name
   (`SOURCES_BY_MANGA_TYPE`; genre/tag based detection is unchanged), so that the shipped bundle names no third-party sites.
   The edit is done by code, with a loud failure if the upstream shape changes, rather than by a patch that would have to quote the list.
7. `npm test`: the synthetic suite. Two audits read the patched WebUI checkout (`SUWAYOMI_WEBUI_SOURCE`) and skip when it is
   absent.
8. `node scripts/package-extension.mjs <out> --target=firefox|chrome` assembles each package; `scripts/zip-package.mjs`
   writes the deterministic ZIP.

Configuration is by environment variables only: `BROWSER_BUILD_CACHE` (work area, default `.cache` inside the tree),
`BROWSER_VM_SOURCE`, `BROWSER_VM_BUILD_DIR`, `SUWAYOMI_WEBUI_SOURCE`, `SOURCE_DATE_EPOCH` (default: the file of that name).

## Tests only

```sh
npm ci
npm test            # runs scripts/prepare-test-runtime.mjs first (bundles vendor/fflate.mjs)
```

The suite is fully synthetic: it signs a generated APK with a throw-away key (`test/synthetic-apk.mjs`) and uses invented
hosts. It needs no third-party binary, no network and no live site.

## Check a package in Firefox

`test/package-gate-firefox.mjs` loads an exact package (ZIP or unpacked folder) in a throw-away Firefox profile whose network
goes to a dead proxy, and checks: manifest as loaded (ID, no `key`, no host permissions, data collection `none`), the WebAssembly
JVM regression suite inside the package (exception handling, locale data, UTF-16 strings, graphics, zstd, cookies), a synthetic library
rendering in the WebUI, the About screen and the launcher (no duplicate tab). It needs Firefox and geckodriver:

```sh
GECKODRIVER=/path/to/geckodriver node test/package-gate-firefox.mjs out/suwayomi-browser-firefox-0.3.6.zip
```

Lint: `npx web-ext@10.5.0 lint --source-dir out/firefox`.

## Source layout and the b-jvm / WebUI patches

b-jvm (WebAssembly JVM) and Suwayomi-WebUI are first-party patched forks: the patches in this repository are applied to the
pinned upstream revisions at build time. They are not third-party libraries with modifications hidden in the bundle; the
build output can be reproduced from this repository alone.
