# AMO reviewer notes — Suwayomi Browser (unofficial) 0.3.6

MPL-2.0. Firefox ID: `suwayomi-browser@bloodyredtangerine`. Minimum Firefox desktop/Android: 154.0.
Homepage: https://github.com/BloodyRedTangerine/suwayomi-browser
Support: https://github.com/BloodyRedTangerine/suwayomi-browser/issues

## Behavior and content

The official Suwayomi WebUI runs against a browser-local IndexedDB backend. No desktop server/native application is needed.
No repositories, source binaries, content or third-party catalogue links are bundled. Screenshots use synthetic data.
The developer receives no data (`data_collection_permissions.required=["none"]`). The public source contains the build and
synthetic tests, not local live-site harnesses or external signed fixtures.

APK v2 and JAR v1 signatures are verified before source execution. Signer pins, downgrade rejection, explicit manual-import
trust and retained-archive verification remain enforced. Source Java/DEX code runs only as data inside the WebAssembly JVM,
in a Worker without WebExtension APIs. It is not loaded as extension-page JavaScript. Extension pages retain
`script-src 'self' 'wasm-unsafe-eval'`.

Source networking requires user-granted optional host permissions; none are granted at install. Redirect hops are checked.
Prompts batch related denials and offer PSL-safe registrable-domain patterns, never broad all-host grants. Permission-only
failures recover after the user's grant. DNR header rules are exact-URL scoped to the extension's requests; webRequest
observes response status/headers, not bodies. Storage/unlimitedStorage hold the local library/downloads. No native messaging,
developer telemetry, manifest key or host_permissions; gecko_android is present.

## Reproducible build

On Linux x86_64 with Docker and network access:

```sh
docker/build-in-docker.sh ./out
unzip suwayomi-browser-firefox-0.3.6.zip -d submitted
diff -r submitted out/firefox
```

Tools, upstream revisions and dependencies are pinned in docker/Dockerfile, UPSTREAM.json, lockfiles and Gradle verification
metadata. Stages compile patched b-jvm and the host JAR, link OpenJDK, build patched WebUI, run synthetic Node tests and
write deterministic packages. No frozen binary overlay is used. Allow about 15 GB disk and 8 GB RAM.
See docs/BUILDING.md and docs/REPRODUCIBLE-BUILD.md. Exact release hashes and the A/B/C proof accompany the release in
SHA256SUMS and the reproducibility report. A source archive cannot contain its own hash.

## Size-only changes in 0.3.6

The Android framework contributes classes/META-INF, not unusable res/resources.arsc/jni/assets. The VM bootstraps from the
linked lib/modules JIMAGE instead of a duplicate JDK JAR. JRT resources, module layers, locale providers and time zones stay
present and are tested in the browser JVM. ICU uses a conservative class dependency closure, shared Unicode/bidi/normalization
data, all break dictionaries and collations; unrelated formatting/transliteration bundles are omitted. Licenses remain.
See docs/PACKAGE-SIZE.md for bounded audit evidence and test coverage. Physical Android re-test is pending with the user.

## First-party modifications and lint

b-jvm and WebUI changes are the source patches in jvm/vm-patches/extension-runtime.patch and webui/browser-local.patch,
applied to pinned commits. A documented release edit removes the upstream site-name heuristic list, not genre/tag detection.
The host build rewrites OkHttp to the broker, skips desktop Zstd native loading (the real codec is in WASM), adapts resource
loading and selects ICU classes/data without rewriting their implementation. Notices ship in THIRD_PARTY_LICENSES and
DEPENDENCIES.json.

Exact web-ext lint output accompanies the release. Expected warnings cover sandbox CSP/eval, sandbox document.write,
pinned UI renderer innerHTML and a constant lodash global-object Function expression, and the host JAR extension.
The WebView sandbox has opaque origin, no extension APIs/network (connect-src 'none'), no nested frames, and authenticated
parent messages. Its HTML is source-fetched content, not remote extension code. The JAR/module image are guest-JVM data
built by the source recipe, not native executable add-on code. No upload, submission or signing is performed here, and no
AMO upload acceptance is claimed.
