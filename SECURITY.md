# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** through GitHub: *Security* tab > *Report a vulnerability* on
https://github.com/BloodyRedTangerine/suwayomi-browser (private vulnerability reporting). If that is unavailable, open an issue that says only that you have a security
report and how to contact you, without details. Please allow reasonable time for a fix before public disclosure.

Supported: the latest release. This is a hobby project without a service-level agreement.

## Scope and trust model

In scope: the extension code in this repository, its sandbox boundaries and its build scripts.

- Source extensions are **third-party code**. They run in a WebAssembly JVM inside a Worker with no WebExtension API access;
  the only channel out is the message protocol to the source broker, which enforces the user-granted host list.
- Package integrity: APK Signature Scheme v2 and JAR v1 signatures are verified before execution; unsigned, invalidly signed
  or downgraded (v3/v3.1 stripping) archives are refused, repository signing keys are pinned and key changes are refused.
- Host access is optional and requested per registrable domain; no host permission is granted at install.
- The extension does not collect or transmit user data to the developer.

Out of scope: the content, behaviour or safety of third-party sources and repositories you choose to add; vulnerabilities in
upstream projects that are not specific to this integration (report those upstream, but tell us too).

## Release integrity

Releases are built reproducibly (see docs/REPRODUCIBLE-BUILD.md) and published with SHA-256 sums. The Chrome/Edge manifest
contains only the public part of the extension key.
