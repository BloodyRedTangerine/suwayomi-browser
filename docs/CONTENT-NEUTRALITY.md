# Content neutrality and tree checks

The add-on ships without sources, catalogues or content, and this repository contains no site names, titles, covers or
page URLs from live sites. `check-public-tree.mjs` enforces that mechanically. It is plain Node, needs no `npm ci`, and fails
(exit status 1) on any finding:

```sh
node check-public-tree.mjs                       # the source tree
node check-public-tree.mjs --package ./out/firefox --package ./out/chrome     # unpacked build outputs
node check-public-tree.mjs --list-allowlist      # every allowlist entry with its reason
```

## Rules

- **Keys and personal data:** private key markers, key/keystore files, e-mail addresses and local account names.
- **Build output and captures:** `node_modules`, caches, generated `runtime/`, `vendor/`, `ui/`, Gradle output, release archives,
  browser profiles, raw logs, raw HTTP captures, screenshots (except the synthetic ones in `AMO/screenshots/`), binaries
  (except the pinned Gradle wrapper and one openly licensed font), files over 5 MB.
- **Local paths:** any `/home/<user>` or `/Users/<user>` path and the local project name. The one documented exemption is
  `/home/web_user`, the constant virtual home directory of the Emscripten file system, which appears in the generated runtime glue.
  In the source tree (never in a package) one path-scoped exception exists: `jvm/vm-patches/extension-runtime.patch` contains, as a
  removed line, the upstream placeholder value of the WebAssembly JVM's `user.home` property, which the patch replaces.
- **Content terms (case-insensitive substring):** names of third-party catalogues and sites, adult-content markers and
  CAPTCHA/challenge vocabulary; the list is in the script.
- **Packages:** additionally no source maps, no `SOURCE/`, `test/` or developer notes, and the same scans inside the JAR files.

## Allowlist (all entries are printed by `--list-allowlist`)

| Where | Terms | Reason |
|---|---|---|
| `check-public-tree.mjs`, `test/check-tree.test.mjs`, this file | all | They contain or describe the denylist. |
| `src/extensions/metadata.mjs`, `repository.mjs`, `src/webui/backend.mjs`, `filters.mjs` and their tests | content-warning enum (SAFE/MIXED/NSFW) | Product behaviour: repositories rate sources and the WebUI filters on that rating. |
| `webui/browser-local.patch` | content-warning enum | Upstream WebUI code appears as patch context. |
| `src/extensions/public-suffix-data.mjs` | one CDN vendor name | Generated Public Suffix List snapshot (domains owned by that vendor). |
| `jvm/src/main/kotlin/eu/kanade/tachiyomi/network/**`, `NetworkCompatSmoke.kt` | one CDN vendor name | Mihon/Tachiyomi extension API identifiers that extensions link against. |
| `jvm/src/main/kotlin/suwayomi/browser/Gateway.kt` | one catalogue operator name | Reflective lookup of the extension-library helper class by its published package name (an API identifier, not a link). |
| `ui/**` in packages | content-warning enum, `18+` rating label, CDN vendor name | Upstream WebUI texts and translations (content-rating settings, a server setting that mentions the CDN vendor) and the bundled Public Suffix List snapshot. |
| `THIRD_PARTY_LICENSES/**` in packages | content-warning enum, CDN vendor name | Verbatim licence texts. Third-party author addresses inside notices (licence texts, `legal/`, compiled library metadata) are not flagged. |
| Compiled host JAR in packages | the two API-identifier names above | Same identifiers, compiled. |
| `runtime/extension-host.jar!/com/ibm/icu/impl/data/icudata/unames.icu` | one adult-content term | ICU4J Unicode character-name data (the script name "Hentaigana"). |
| OpenJDK `lib/modules`, `XMLEntityManager.class` | `/home/` path | Unmodified OpenJDK class containing a constant example path from the JDK sources; not a build-machine path. |
