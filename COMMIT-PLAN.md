# COMMIT-PLAN: suwayomi-browser (PUBLIC)

Prepared locally. **Nothing has been committed, no remote was added, nothing was pushed.** You run the commands below
with your own identity.

## Repository

- GitHub name: `BloodyRedTangerine/suwayomi-browser`
- Visibility: **Public** (create it empty on GitHub: no README, no .gitignore, no licence template)
- Homepage / support: https://github.com/BloodyRedTangerine/suwayomi-browser (issues are the support channel)
- Licence: MPL-2.0 (`LICENSE`)
- Folder to turn into the repository: the prepared folder named `repo-public-suwayomi-browser` (copy it wherever you keep your projects)

## What gets committed

261 files, 2.2 MiB, in:

- `.gitattributes`
- `.gitignore`
- `AMO/` (4 files)
- `LICENSE`
- `README.md`
- `SECURITY.md`
- `SOURCE_DATE_EPOCH`
- `THIRD_PARTY_LICENSES/` (1 files)
- `UPSTREAM.json`
- `check-public-tree.mjs`
- `docker/` (4 files)
- `docs/` (4 files)
- `extension-background.mjs`
- `icon.svg`
- `index.html`
- `jvm/` (125 files)
- `launcher.html`
- `launcher.mjs`
- `manifest.json`
- `package-lock.json`
- `package.json`
- `recovery.html`
- `scripts/` (12 files)
- `src/` (42 files)
- `test/` (51 files)
- `webui/` (1 files)

Everything not listed is excluded by `.gitignore` (first section of the file, reproduced by `check-public-tree.mjs`):
`node_modules/`, caches, `runtime/`, `vendor/`, `ui*/`, `jvm/build`, release ZIPs, profiles, logs, screenshots (except AMO/screenshots/), key files.

## Before the first commit

```sh
cd /path/to/repo-public-suwayomi-browser
node check-public-tree.mjs        # must print "0 finding(s)"
npm ci && npm test        # optional: the reduced synthetic suite
```

## Commit message

```text
Suwayomi Browser (unofficial) 0.3.5: first public source release

Local-first manga library for Firefox (desktop + Android) and Chrome/Edge:
the Suwayomi WebUI running against a browser-local backend, with Mihon/
Tachiyomi-API source extensions executed inside a sandboxed WebAssembly JVM.
No sources or repositories are bundled. MPL-2.0. Reproducible container
build: see docs/REPRODUCIBLE-BUILD.md.
```

## Commands (run these yourself)

Use the GitHub no-reply address shown at https://github.com/settings/emails (format `<ID>+BloodyRedTangerine@users.noreply.github.com`)
so the commit does not carry any other identity. Configure it **locally** in this repository only:

```sh
cd /path/to/repo-public-suwayomi-browser
git init -b main
git config --local user.name  "BloodyRedTangerine"
git config --local user.email "<ID>+BloodyRedTangerine@users.noreply.github.com"
git config --local commit.gpgsign false      # or set up a signing key for this identity
git add -A
git status --short | head -50                # review once
git commit -F - <<'MSG'
Suwayomi Browser (unofficial) 0.3.5: first public source release

Local-first manga library for Firefox (desktop + Android) and Chrome/Edge:
the Suwayomi WebUI running against a browser-local backend, with Mihon/
Tachiyomi-API source extensions executed inside a sandboxed WebAssembly JVM.
No sources or repositories are bundled. MPL-2.0. Reproducible container
build: see docs/REPRODUCIBLE-BUILD.md.
MSG
git log -1 --format='%an <%ae>'              # confirm the identity
git remote add origin git@github-brt:BloodyRedTangerine/suwayomi-browser.git
git push -u origin main
git tag -a v0.3.5 -m 'Suwayomi Browser (unofficial) 0.3.5'
git push origin v0.3.5
```

`github-brt` is your SSH host alias (`~/.ssh/config`: `Host github-brt`, `HostName github.com`, `User git`, `IdentityFile <key for BloodyRedTangerine>`).
If the first push is rejected because the empty repository was initialised with files, do not force-push: inspect with
`git fetch origin && git log origin/main`.
