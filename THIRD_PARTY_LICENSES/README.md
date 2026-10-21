# Third-party licences

This folder documents the licences of what this repository **ships**. The verbatim licence texts are collected at build time
into the `THIRD_PARTY_LICENSES/` folder of each package (with an `INDEX.md` listing every component, version and licence),
limited to the components that are actually shipped:

| Component | Licence | How it is covered in the package |
|---|---|---|
| Suwayomi WebUI (patched) | MPL-2.0 | `THIRD_PARTY_LICENSES/suwayomi-webui/`; every npm module in the WebUI bundle (the bundler's module list), under `webui-js/` |
| b-jvm | MIT | `THIRD_PARTY_LICENSES/b-jvm/` |
| Zstandard | BSD-3-Clause or GPL-2.0 | `THIRD_PARTY_LICENSES/zstd/` |
| QuickJS (quickjs-emscripten and its WebAssembly build), fflate | MIT | `THIRD_PARTY_LICENSES/runtime-js/` |
| Amazon Corretto / OpenJDK class libraries, including `jdk.localedata` (Unicode CLDR data) | GPL-2.0 with Classpath Exception; Unicode licence | `vendor/bjvm/jre/legal/` |
| JVM libraries bundled in the host JAR (OkHttp, Okio, Kotlin, kotlinx, jsoup, RxJava, dex2jar, ICU4J, ASM, ...) | see each notice | `THIRD_PARTY_LICENSES/jvm/<coordinate>/`, hashes in `DEPENDENCIES.json` |
| Android Open Source Project Base64 | Apache-2.0 | `THIRD_PARTY_LICENSES/AndroidCompat/` |
| Public Suffix List snapshot | MPL-2.0 | derived from the OkHttp resource; this repository's `LICENSE` |
| Hack font (graphics probe only, inside the host JAR) | MIT / Bitstream Vera | `PROBE-FONT-LICENSE.txt` next to the font in `jvm/src/main/resources` |

This repository's own code is MPL-2.0 (`LICENSE`).
