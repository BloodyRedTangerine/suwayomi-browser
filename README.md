# Suwayomi Browser (unofficial)

A manga/comic library and reader that runs entirely inside your browser: the [Suwayomi WebUI](https://github.com/Suwayomi/Suwayomi-WebUI)
talking to a **browser-local backend** (IndexedDB) instead of a desktop server. Source extensions written for the
Mihon/Tachiyomi extension API (Java bytecode) are executed locally inside a **sandboxed WebAssembly JVM**; no desktop Java,
native helper or server is involved.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by the Suwayomi, Mihon or Tachiyomi projects.
> It reuses their open-source work (credits below). Compatibility is partial: not every source or Android API is supported.

- Targets: Firefox desktop and Firefox for Android (Firefox 154 or later), Chrome and Edge (Manifest V3).
- Version: 0.3.5. Licence: [MPL-2.0](LICENSE). Support: [GitHub issues](https://github.com/BloodyRedTangerine/suwayomi-browser/issues).
- **No content is bundled.** The extension ships with no sources and no repositories. You choose which repository URL to add
  and which sources to install, like a user-script manager. Third-party sources are third-party code: review and trust them
  before use.
- **No data collection.** Nothing is sent to the developer. Your library, settings and downloaded pages stay in the browser
  profile (IndexedDB). `data_collection_permissions` is `none`.

## How it works (short)

| Piece | Role |
|---|---|
| Suwayomi WebUI (patched) | The user interface, built from the pinned upstream revision plus `webui/browser-local.patch`. |
| Browser-local backend (`src/webui`) | Implements the GraphQL/REST surface the WebUI needs on top of IndexedDB. |
| Extension runtime (`src/extensions`, `jvm/`, b-jvm) | Loads source packages, verifies their signatures and runs them in a WebAssembly JVM inside a Worker. |
| Source broker (background page) | The only code that touches the network on behalf of sources, limited to hosts you grant per site. |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and [SECURITY.md](SECURITY.md) for the trust model.

## Install

- **Firefox / Firefox for Android:** install from addons.mozilla.org once listed (search "Suwayomi Browser (unofficial)").
  Add-on ID: `suwayomi-browser@bloodyredtangerine`. The Firefox ZIP in the GitHub release is the unsigned package that is submitted to AMO; for
  development it can be loaded temporarily from `about:debugging`.
- **Chrome / Edge:** download `suwayomi-browser-0.3.5.zip` from the GitHub release, unzip it, open
  `chrome://extensions` (or `edge://extensions`), enable *Developer mode* and choose *Load unpacked*.
  The manifest carries the **public** part of the extension key (`key`), which pins the extension ID to `jcjicocbfnajldjccnfnglphngckjkfn`
  so data survives reinstalls. It is a public key; the private key is not in this repository. Firefox builds strip it.

## Build

Everything needed to build the packages from source is in this repository. The supported route is one command in a pinned
container (Ubuntu 24.04, x86_64):

```sh
docker/build-in-docker.sh ./out     # builds the image, then both packages into ./out
```

Toolchain details, the manual steps and the layout requirement (the tree is placed at `browser/` inside a Suwayomi-Server
checkout at a pinned revision) are in [docs/BUILDING.md](docs/BUILDING.md). To run only the synthetic test suite:

```sh
npm ci
npm test
```

## Verify a release

1. Compare the SHA-256 of the file you downloaded with `SHA256SUMS` published with the GitHub release.
2. Rebuild from the tagged source with `docker/build-in-docker.sh` and compare: the build is reproducible, so the unpacked
   packages and both ZIPs are byte-identical to the release (`docker/compare.sh <your-out> <release-out>`).
3. The Firefox add-on submitted to addons.mozilla.org is built from exactly this source with this container.
   [docs/REPRODUCIBLE-BUILD.md](docs/REPRODUCIBLE-BUILD.md) explains what makes the output reproducible and records the
   verification runs.
4. `node check-public-tree.mjs` verifies the source tree, and `node check-public-tree.mjs --package <dir>` an unpacked
   package, for keys, personal data, local paths and content-neutrality (see [docs/CONTENT-NEUTRALITY.md](docs/CONTENT-NEUTRALITY.md)).

## Repository layout

- `src/`, `extension-background.mjs`, `launcher.*`, `index.html`, `recovery.html`, `manifest.json`: the extension.
- `jvm/`: Kotlin/Java host that runs inside the WebAssembly JVM, Gradle build, and `vm-patches/` (the b-jvm patch).
- `webui/browser-local.patch`: the WebUI changes.
- `scripts/`: release build, packaging and verification scripts. `docker/`: the reproducible build environment.
- `test/`: the synthetic test suite (no third-party binaries, no live sites).
- `AMO/`: listing text, reviewer notes and screenshots for addons.mozilla.org.
- `UPSTREAM.json`: pinned upstream revisions. `SOURCE_DATE_EPOCH`: the declared build timestamp.

## Credits

[Suwayomi-WebUI](https://github.com/Suwayomi/Suwayomi-WebUI) and [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)
(MPL-2.0), [b-jvm](https://github.com/anematode/b-jvm) (WebAssembly JVM), Zstandard, QuickJS (via quickjs-emscripten),
fflate, Amazon Corretto/OpenJDK class libraries and the JVM libraries listed in `THIRD_PARTY_LICENSES` of each package.
