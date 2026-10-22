# Reproducible build

Building the same source in the provided Docker container always gives the same files, byte for byte. Build time, folder
names and the machine don't change the result. So you can check that a release was really built from this repository.

## Check a release

1. Download the release ZIP and `SHA256SUMS`, and check the hash: `sha256sum -c SHA256SUMS --ignore-missing`.
2. Check out the matching tag (for example `git checkout v0.3.6`) and build: `docker/build-in-docker.sh ./out`.
3. Compare: the two extension ZIPs in `out/SHA256SUMS` should have the same hashes as in the release. To compare file by file, unzip the release ZIP and run
   `diff -r <unzipped-release> out/firefox` (or `out/chrome`).

To check that the build itself is stable, build twice and compare:

```sh
docker/build-in-docker.sh ./out-1
docker/build-in-docker.sh ./out-2
docker/compare.sh ./out-1 ./out-2
```

## What keeps it reproducible

| What could change the output | How it is fixed |
|---|---|
| Time stamps | Every archive uses the single date in `SOURCE_DATE_EPOCH`. ZIP entries are sorted and carry no extra attributes. |
| Build folder paths | b-jvm is compiled with `-ffile-prefix-map`; the build fails if a machine path ends up in the output. The WebUI build fails on source maps or build paths. |
| Dependency versions | npm and pnpm lockfiles, Gradle dependency verification (`jvm/gradle/verification-metadata.xml`) with a pinned wrapper, pinned upstream commits, and checksummed Node, CMake, Ninja, JDK, Corretto and Emscripten downloads. |
| Locale and time zone | The container sets `TZ=UTC` and `LANG=C.UTF-8`. |
| File order | Directory listings are sorted, and so are ZIP entries. |
