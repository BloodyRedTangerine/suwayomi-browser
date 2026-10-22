# Security

## Reporting a problem

Please report security problems privately: open the **Security** tab of this repository and choose **Report a vulnerability**.
If that doesn't work, open an issue that only says you have a security report, without details, and I'll contact you.

Only the latest release gets fixes. This is a hobby project, so fixes come as time allows.

## How the extension protects you

- **Sources are third-party code.** They run in a separate sandbox (a Java virtual machine compiled to WebAssembly) that cannot
  use the browser's extension features. They can only ask the extension to fetch pages, and only from sites you allowed.
- **Signatures are checked.** A source package must be signed, and its signature is checked before it runs. Unsigned or
  modified packages are refused, and a source cannot switch to a different signing key on update.
- **Site access is opt-in.** Nothing is granted at install. The browser asks you the first time each site is needed.
- **No data collection.** Nothing is sent to the developer.

Not covered: the content or behavior of the repositories and sources you choose to add, and bugs in upstream projects (please
report those upstream too).

## Checking a download

Each release lists SHA-256 hashes in `SHA256SUMS`. The packages can be rebuilt from this repository and compared byte for
byte; see [docs/REPRODUCIBLE-BUILD.md](docs/REPRODUCIBLE-BUILD.md).
