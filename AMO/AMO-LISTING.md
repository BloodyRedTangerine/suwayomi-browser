# AMO listing: Suwayomi Browser (unofficial)

Content-neutral. No source names, repository links, catalogue links, titles, covers or page URLs appear in this text or in the
screenshots (`AMO/screenshots/` are generated from the built-in synthetic library).

| Field | Value |
|---|---|
| Name | **Suwayomi Browser (unofficial)** |
| Add-on ID (permanent) | `suwayomi-browser@bloodyredtangerine` |
| Summary (max 250 characters; this one is 206) | A local manga and comic library and reader that runs entirely in your browser: the Suwayomi web interface with a browser-local backend. No desktop server, no data collection, no sources bundled. Unofficial. |
| Version | 0.3.5 |
| Compatible with | Firefox (desktop) 154.0 or later and Firefox for Android 154.0 or later |
| Listing visibility | Public (listed on addons.mozilla.org) |
| Categories (choose up to two in the form) | Games & Entertainment; Other. Firefox for Android: Games & entertainment. Confirm the exact names offered by the Developer Hub. |
| Tags | manga, comics, reader, library, offline, webassembly, suwayomi, mihon |
| License | Mozilla Public License 2.0 (MPL-2.0) |
| Homepage | https://github.com/BloodyRedTangerine/suwayomi-browser |
| Support site | https://github.com/BloodyRedTangerine/suwayomi-browser/issues |
| Support e-mail | Optional; leave empty or use the GitHub no-reply address. |
| Privacy policy | Not required: the add-on declares `data_collection_permissions: required: none`. |
| Requires payment / hardware | No |
| Mark as experimental | Recommended for the first release (Android verification is still limited); your decision. |

## Description (paste into the AMO description field)

**Suwayomi Browser (unofficial)** is a manga and comic library and reader that runs entirely inside your browser. It is the
Suwayomi web interface connected to a browser-local backend, so there is no desktop application or server to install.

**What you get**
- A familiar library, categories, history, updates, downloads and a reader.
- Your library, settings and downloaded pages stay in your browser profile. Nothing is sent to the developer; the add-on declares
  no data collection.
- Works in Firefox on desktop and on Android.
- Backup and restore of your library as a file.

**Bring your own sources**
The add-on ships with **no sources and no repositories**. If you want to read online content, you add a repository address of
your choice and install the sources you want, much like a user-script manager. Sources are third-party programs: they run inside a
sandbox (a Java virtual machine compiled to WebAssembly) that cannot use the browser's extension APIs, and every source package must
carry a valid signature that is checked before it runs. Review and trust the repositories you add.

**Permissions, explained**
- Site access is **optional** and is requested one website at a time, only when you add a repository or use a source on that site.
  Nothing is granted when you install the add-on.
- Request-header and response-header permissions are used only for the add-on's own source requests, so that sources work as
  they do in the desktop application.
- Storage permissions keep your library and downloaded chapters on your device.

**Good to know**
- This is an unofficial project and is not affiliated with Suwayomi, Mihon or Tachiyomi. Compatibility is partial: not every source or
  Android feature is supported.
- On Firefox for Android, open the add-on from the add-ons menu (Settings under the add-on) and bookmark the page.
- Open source (MPL-2.0): https://github.com/BloodyRedTangerine/suwayomi-browser. The build is reproducible and documented in the repository.

## Notes to reviewer field

Paste the short pointer below; the full text is `AMO-REVIEWER-NOTES.md` (also in the source archive):

> Source code is attached. Build: `docker/build-in-docker.sh` (Ubuntu 24.04 x86_64, pinned toolchain; details in
> docs/BUILDING.md). The build is reproducible: the attached ZIP equals the container output. Full notes: AMO/AMO-REVIEWER-NOTES.md.
