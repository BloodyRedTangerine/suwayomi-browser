# Notes for AMO reviewers: Suwayomi Browser (unofficial) 0.3.5

## What it is

A local manga/comic library and reader. The Suwayomi WebUI (MPL-2.0) runs against a **browser-local backend** (IndexedDB); no
server is contacted and nothing is transmitted to the developer (`data_collection_permissions`: `none`). Source code and
issue tracker: https://github.com/BloodyRedTangerine/suwayomi-browser.

## No bundled content

The add-on ships **no sources, no source repositories and no catalogue links**. The user chooses a repository URL and which sources
to install, like a user-script manager. The listing, screenshots (synthetic) and package are content-neutral.

## Sandboxing of downloaded source code

Source packages (Java bytecode/DEX, written for the Mihon/Tachiyomi extension API) are downloaded **as data** from user-chosen
repositories and executed only inside a WebAssembly JVM (b-jvm, built from source in this archive) in a dedicated Worker. That
guest has **no access to WebExtension APIs**: the only channel out is a message protocol to the background page. The add-on does
not load remote code into any extension page; extension pages use `script-src 'self' 'wasm-unsafe-eval'`.

## Network access and permissions

All source traffic goes through a broker in the background page and is limited to hosts the user grants **per site**
(`optional_host_permissions`; nothing is granted at install, no `<all_urls>` grant, no `host_permissions`). Requests are made
only after a user action (add repository, install/update a source, browse/read). `declarativeNetRequestWithHostAccess` sets request
headers that sources require, scoped to the extension's own requests; `webRequest` observes response headers/status of those requests
(no blocking, no body access). `storage`/`unlimitedStorage` hold the local library and downloaded pages.

## Integrity of source packages

APK Signature Scheme v2 (verified in JavaScript with WebCrypto) and JAR v1 (verified inside the JVM) signatures are checked before any
code runs. Unsigned, invalidly signed or downgraded archives are refused everywhere, including manual import. A repository's declared
signing fingerprint is pinned and key changes are refused; manual imports require explicit confirmation of the signer, which is then
pinned. Retained archives are re-verified at every start. (Tests: `test/signature.test.mjs`, `test/manager-trust.test.mjs`, using a
generated signed APK.)

## Build from source (reproducible)

Environment: **Ubuntu 24.04, x86_64**, Docker. One command from the unpacked source archive:

```sh
docker/build-in-docker.sh ./out
```

This builds `docker/Dockerfile` (every tool pinned: Node 24.21.0, pnpm 11.1.2, Temurin 21.0.12.1+1, Gradle 9.8.1, Emscripten 4.0.2,
CMake 3.31.6, Ninja 1.13.2) and runs `docker/build.sh`, which clones each upstream at the revision in `UPSTREAM.json`
(Suwayomi-Server, b-jvm, Suwayomi-WebUI), applies the included patches, runs `npm ci`, Gradle, the Emscripten build, the WebUI build
and the tests, and writes both packages and deterministic ZIPs to `./out`. To compare with the submitted package:
`unzip -d x suwayomi-browser-firefox-0.3.5.zip` and `diff -r x out/firefox` (or compare the ZIP SHA-256 in `out/SHA256SUMS`);
the build is byte-reproducible (`docker/compare.sh`, `docs/REPRODUCIBLE-BUILD.md` records three verification builds: fresh,
second fresh, and a different host/container path).
Submitted package: `suwayomi-browser-firefox-0.3.5.zip`, SHA-256 `0cebdb30597f658689540340caae2bb90c9b11e3b340b745760186c6ad0f3517`. (The hash of the source archive itself is in `SHA256SUMS` next to it; an archive cannot contain its own hash.)

Machine requirements: x86_64 (the build downloads x86_64 Corretto and Emscripten binaries), about 15 GB disk, 8 GB RAM, network.
Only `browserJar` is needed from Gradle; no test fixtures or third-party binaries are required.

## First-party patched upstreams

**b-jvm** (WebAssembly JVM) and **Suwayomi-WebUI** are first-party patched forks: unmodified upstream commits plus the patches in
`jvm/vm-patches/extension-runtime.patch` and `webui/browser-local.patch`, applied by the build at the pinned revisions. They are
not third-party libraries with undisclosed modifications; nothing minified or generated is checked in. One further build-time edit is made
by code (`scripts/build-webui.mjs`, `BROWSER_RELEASE_EDITS=1`): the upstream WebUI's heuristic list of third-party site names
(`SOURCES_BY_MANGA_TYPE`) is emptied so that the package names no sites; genre/tag-based type detection is unchanged. Third-party npm/JVM
dependencies are unmodified and pinned by lockfiles and Gradle dependency verification. Licences of everything shipped are in
`THIRD_PARTY_LICENSES/` of the package.

## Lint

`web-ext lint` web-ext 10.5.0 on the submitted package: **0 errors, 13 warnings, 0 notices.**

| # | Code | File | Message | Explanation |
|---|---|---|---|---|
| 1 | `MANIFEST_CSP_UNSAFE_EVAL` | `manifest.json` | "content_security_policy.sandbox" allows 'eval', which has strong security and performance implications. | Applies to the declared **sandbox** page only (`src/extensions/webview-sandbox.html`; opaque origin, no extension APIs, `connect-src 'none'`, `frame-src 'none'`). It hosts the isolated WebView facade that Android source extensions require (the equivalent of Android's WebView): documents a source itself fetched are rendered there. Extension pages keep `script-src 'self' 'wasm-unsafe-eval'` and load no remote code. |
| 2 | `MANIFEST_CSP` | `manifest.json` | "content_security_policy.sandbox" allows remote code execution in manifest.json | Applies to the declared **sandbox** page only (`src/extensions/webview-sandbox.html`; opaque origin, no extension APIs, `connect-src 'none'`, `frame-src 'none'`). It hosts the isolated WebView facade that Android source extensions require (the equivalent of Android's WebView): documents a source itself fetched are rendered there. Extension pages keep `script-src 'self' 'wasm-unsafe-eval'` and load no remote code. |
| 3 | `NO_DOCUMENT_WRITE` | `src/extensions/webview-sandbox.js:14` | Use of document.write strongly discouraged. | First-party code (a short script) inside the sandbox page above. On a message from the owning extension page it writes the HTML document a source requested (WebView `loadDataWithBaseURL`) into the sandboxed frame. The frame has no extension API access (the script refuses to run otherwise), no network (`connect-src 'none'`) and an opaque origin; the message is accepted only from the parent with a per-frame random key. |
| 4 | `UNSAFE_VAR_ASSIGNMENT` | `src/extensions/webview-sandbox.js:14` | Unsafe call to document.write for argument 0 | First-party code (a short script) inside the sandbox page above. On a message from the owning extension page it writes the HTML document a source requested (WebView `loadDataWithBaseURL`) into the sandboxed frame. The frame has no extension API access (the script refuses to run otherwise), no network (`connect-src 'none'`) and an opaque origin; the message is accepted only from the parent with a per-frame random key. |
| 5 | `UNSAFE_VAR_ASSIGNMENT` | `ui/assets/ContinueReadingTooltip-B5H72POQ.js:1` | Unsafe assignment to innerHTML | Unmodified third-party code in the WebUI bundle: the MUI X date-time field writes its formatted section text into its own input element (`innerHTML` of a field section it created). |
| 6 | `UNSAFE_VAR_ASSIGNMENT` | `ui/assets/ContinueReadingTooltip-B5H72POQ.js:1` | Unsafe assignment to innerHTML | Unmodified third-party code in the WebUI bundle: the MUI X date-time field writes its formatted section text into its own input element (`innerHTML` of a field section it created). |
| 7 | `UNSAFE_VAR_ASSIGNMENT` | `ui/assets/Manga-GJiNl8K9.js:11` | Unsafe assignment to innerHTML | Unmodified third-party code in the WebUI bundle: the Tiptap/ProseMirror rich-text editor used for notes (parses its own, sanitised content; injects its own `<style>` element). |
| 8 | `UNSAFE_VAR_ASSIGNMENT` | `ui/assets/Manga-GJiNl8K9.js:13` | Unsafe assignment to innerHTML | Unmodified third-party code in the WebUI bundle: the Tiptap/ProseMirror rich-text editor used for notes (parses its own, sanitised content; injects its own `<style>` element). |
| 9 | `UNSAFE_VAR_ASSIGNMENT` | `ui/assets/index-io02HHUI.js:10` | Unsafe assignment to innerHTML | Unmodified third-party code in the WebUI bundle: React DOM's implementation of `dangerouslySetInnerHTML` (React's own renderer; the WebUI does not feed remote HTML into it). |
| 10 | `UNSAFE_VAR_ASSIGNMENT` | `ui/assets/index-io02HHUI.js:10` | Unsafe assignment to innerHTML | Unmodified third-party code in the WebUI bundle: React DOM's implementation of `dangerouslySetInnerHTML` (React's own renderer; the WebUI does not feed remote HTML into it). |
| 11 | `DANGEROUS_EVAL` | `ui/assets/index-io02HHUI.js:12900` | The Function constructor is eval. | Unmodified third-party code in the WebUI bundle: lodash's global-object detection (`Function("return this")()`), a constant string, not dynamic code. |
| 12 | `FLAGGED_FILE_EXTENSION` | `vendor/bjvm/jre/jdk23.jar` | Flagged file extensions found | Notice for bundled **build artifacts**, not executable extension code: `runtime/extension-host.jar` (compiled from `jvm/` and the pinned dependencies) and `vendor/bjvm/jre/jdk23.jar` (Java class libraries) are data files loaded into the sandboxed WebAssembly JVM. Both are produced by the reproducible build from the source in this archive. |
| 13 | `FLAGGED_FILE_EXTENSION` | `runtime/extension-host.jar` | Flagged file extensions found | Notice for bundled **build artifacts**, not executable extension code: `runtime/extension-host.jar` (compiled from `jvm/` and the pinned dependencies) and `vendor/bjvm/jre/jdk23.jar` (Java class libraries) are data files loaded into the sandboxed WebAssembly JVM. Both are produced by the reproducible build from the source in this archive. |

## Manifest

Firefox ID `suwayomi-browser@bloodyredtangerine`, `strict_min_version` 154.0 (declared sandbox pages keep opaque isolation from that version),
`gecko_android` present, `data_collection_permissions`: `{"required":["none"]}`, no `key`, no `host_permissions`,
`homepage_url` https://github.com/BloodyRedTangerine/suwayomi-browser.
