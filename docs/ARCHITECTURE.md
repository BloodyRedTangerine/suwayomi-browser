# Architecture

## Overview

```
 WebUI (React, patched)  ──GraphQL/REST──▶  browser-local backend (src/webui/backend.mjs, IndexedDB)
                                                   │
                                      extension manager (src/extensions/manager.mjs)
                                                   │  verified source packages
                              Worker ──▶ b-jvm WebAssembly JVM ──▶ host classes (jvm/, Kotlin/Java)
                                                   │ source HTTP / WebView requests (messages only)
                                       source broker in the background page (src/extensions/broker.mjs)
                                                   │ per-host permission + header rules
                                                 network
```

## Components

- **Extension shell** (`manifest.json`, `extension-background.mjs`, `launcher.*`, `index.html`, `recovery.html`). The toolbar
  action and the options page (a launcher) open the WebUI in a tab, reusing an existing tab. Manifest V3; Firefox builds use
  `background.scripts` and a declared sandbox page (see `scripts/target-manifest.mjs`, the only per-browser difference).
- **WebUI.** The unmodified Suwayomi WebUI at a pinned revision, plus `webui/browser-local.patch` which swaps its network layer
  for a local transport, adds browser-specific notices (permission prompts, storage status, diagnostics) and disables server-only
  features (server/WebUI update checks, sync).
- **Browser-local backend** (`src/webui/`, `src/core.mjs`). Library, categories, chapters, downloads, backups, updates and
  tracking records live in IndexedDB (`settings` store; page blobs for offline reading). Cross-tab work is coordinated with
  Web Locks and BroadcastChannel. Filters are evaluated with the same semantics as the desktop server's SQL filters.
- **Extension manager** (`src/extensions/manager.mjs`, `package.mjs`, `signature.mjs`, `trust-policy.mjs`). Imports source
  packages, inspects them, **verifies their signature** (APK Signature Scheme v2 in JavaScript with WebCrypto; JAR v1 inside
  the JVM), pins the signer per repository and per package, and refuses unsigned or invalidly signed archives everywhere, including
  manual import. Installed archives are kept so they can be re-verified at every start.
- **Repositories** (`src/extensions/repository.mjs`). Parses the repository index formats the Suwayomi server understands. The
  application ships with none: the user adds a repository URL.
- **Runtime** (`src/extensions/runtime.mjs`, `worker.mjs`, `vendor/bjvm`). A Worker runs b-jvm (a JVM compiled to
  WebAssembly) with the Corretto class libraries in `vendor/bjvm/jre`. The guest has no access to WebExtension APIs: it can only
  exchange messages with the host page. Android API shims (`jvm/src/main/java/android/**`) cover the subset sources use.
  Short page scripts run in QuickJS (WebAssembly) with memory and time limits.
- **Host classes** (`jvm/`). Kotlin/Java code compiled into `runtime/extension-host.jar`: the Mihon/Tachiyomi extension API
  surface (from the unmodified Suwayomi-Server sources), an OkHttp call replacement that forwards requests to the broker,
  cookie and preference stores, image codecs and the dex2jar conversion of Android packages.
- **Source broker** (`src/extensions/broker.mjs`, `transport.mjs`, `response-headers.mjs`, `platform.mjs`). All source
  traffic goes through the background page. It enforces the user-granted host list, applies per-request header rules with
  `declarativeNetRequest` rules scoped to the extension's own requests, and observes response headers with `webRequest`
  (no blocking, no body access). Host access is requested lazily, per site, as `optional_host_permissions`.
- **WebView facade** (`src/extensions/webview*.mjs`, `webview-sandbox.html`). Sources that need a page context run in a sandboxed
  frame with an opaque origin and a restrictive Content-Security-Policy; navigation and subresources are brokered.

## Data and privacy

No analytics, telemetry or developer-operated server. Network requests are made only to repository and source hosts the user
configured, through the broker. A "Copy diagnostics" action in Settings > About copies a redacted report to the clipboard only
on click.

## Permissions

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Local library and downloaded pages. |
| `declarativeNetRequestWithHostAccess` | Set request headers (for example Referer/User-Agent) that sources require, only for the extension's own requests and only on granted hosts. |
| `webRequest` | Observe response headers/status of the extension's own requests (no blocking). |
| `optional_host_permissions` (`https://*/*`, `http://*/*`) | Not granted at install. Requested one registrable domain at a time when the user adds a repository, installs or uses a source. |
