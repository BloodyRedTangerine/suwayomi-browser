# Reproducible build

The release packages are byte-for-byte reproducible: the same source tree built in the pinned container produces identical
unpacked packages and identical ZIPs, regardless of build time, host path or container path.

## What makes it reproducible

| Source of variation | Handling |
|---|---|
| Timestamps | `SOURCE_DATE_EPOCH` (file in the tree, 2026-10-21T00:00:00Z) is the only time ever written into outputs: Gradle archives (`isPreserveFileTimestamps = false`, reproducible file order), the host JAR rewrite (`PatchOkHttp`), `jdk23.jar` and the release ZIPs (`scripts/deterministic-zip.mjs`: sorted entries, UTC DOS time, no extra attributes). |
| Absolute build paths in WebAssembly | b-jvm is compiled with `-ffile-prefix-map` for the source and build trees; `build-vm.mjs` fails if a machine path survives. |
| Build-machine paths in the WebUI and JS | `build-webui.mjs` fails on source maps or build paths in the output. |
| Dependency drift | npm and pnpm lockfiles (`npm ci`, `--frozen-lockfile`); Gradle dependency verification (`jvm/gradle/verification-metadata.xml`) and a pinned wrapper; pinned upstream commits; checksummed Node, CMake, Ninja, JDK and Corretto archives; pinned Emscripten. |
| Locale and time zone | `TZ=UTC`, `LANG=C.UTF-8` in the container. |
| File order | All directory walks are sorted; the ZIP writer sorts entries. |

## Verify a build yourself

```sh
docker/build-in-docker.sh ./out-1
docker/build-in-docker.sh ./out-2
docker/compare.sh ./out-1 ./out-2     # diff -r of both packages, per-file SHA-256 manifests, ZIPs byte-for-byte
```

`SOURCE_DATE_EPOCH` and the tool versions are part of the source tree, so a rebuild of a tagged release matches the published
hashes.

## Verification record

All compared builds are identical: `diff -r` of the unpacked Firefox and Chrome packages shows no differences, the sorted per-file SHA-256 manifests are identical, and both ZIPs and `SHA256SUMS` are byte-for-byte equal.

| Build | How | Firefox ZIP SHA-256 | Chrome ZIP SHA-256 |
|---|---|---|---|
| A | fresh image (`--no-cache`), fresh container, source at `/src`, work in `/build` | `0cebdb30597f658689540340caae2bb90c9b11e3b340b745760186c6ad0f3517` | `ce6c5683c0c5615d6d2a7248d83ef411667600d1329142bcc9e672ced481dd12` |
| B | second fresh image (`--no-cache`) and container, same paths | `0cebdb30597f658689540340caae2bb90c9b11e3b340b745760186c6ad0f3517` | `ce6c5683c0c5615d6d2a7248d83ef411667600d1329142bcc9e672ced481dd12` |
| C | image A, source copy at a different host path mounted at `/work/alt/src`, work in `/work/alt/build`, output `/work/alt/out` | `0cebdb30597f658689540340caae2bb90c9b11e3b340b745760186c6ad0f3517` | `ce6c5683c0c5615d6d2a7248d83ef411667600d1329142bcc9e672ced481dd12` |

Comparison: A vs B: diff-r firefox=identical, manifest firefox=identical, zip firefox=identical, diff-r chrome=identical, manifest chrome=identical, zip chrome=identical, SHA256SUMS=identical; A vs C: diff-r firefox=identical, manifest firefox=identical, zip firefox=identical, diff-r chrome=identical, manifest chrome=identical, zip chrome=identical, SHA256SUMS=identical
