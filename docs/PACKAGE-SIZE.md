# Runtime packaging, 0.3.6

No source API or permission behavior is intentionally changed. The build removes duplicate/unusable data, not source
extensions, language coverage or signature verification. End-user Android re-verification remains a manual release step.

## Android framework

Only classes and META-INF from the pinned framework dependency enter the host JAR. Android APK resources (`res/`,
`resources.arsc`, `jni/`, assets and other non-class files) are not an Android installation in this runtime. Local framework
facades implement display metrics and view IDs without loading that resource table. Bundled desktop Zstd JNI payloads are
excluded too: their loader is already replaced, and the real codec runs in WASM. The local six signed fixture pairs and
35-APK audit find no resource-table lookup requirement: observed resource calls are display metrics, and the inlined ID
`0x01020019` is the framework button1 view ID (confirmed from the pinned framework constants), not an asset. Static auditing
is bounded evidence, not proof about every future source.

## One Java module image

`lib/modules` is necessary: removing it breaks class resources, Java's JRT filesystem, normalization and locale/resource
initialization. Instead the patched VM reads the same compressed JIMAGE for bootstrap classes. This removes the redundant
flattened JDK JAR while retaining module layers, JRT resources, all selected locale providers and time-zone data.
The native tests cover stored/ZIP-compressed entries, malformed indexes, unsupported/corrupt compression, and the actual
pinned linked image. The browser regression probes exercise Object.class resources, module resources, the JRT filesystem,
the boot module layer, normalization, time zones and localized date parsing.

## ICU subset

`IcuSubset` computes a conservative **class-level** constant-pool dependency closure, including reflective full class-name
strings and explicit break/collation service roots. Retained classes are not rewritten. All break dictionaries/rules and
collations remain, plus Unicode/bidi/normalization data and the shared root/locale metadata. Unrelated formatting and
transliteration bundles are excluded. This intentionally retains shared reachable implementation classes rather than
attempting unsafe method-level trimming. Licenses/configuration remain.

The browser tests exercise normalization, collation-aware search, grapheme boundaries (combining marks and emoji ZWJ),
Thai/Japanese/Chinese/Khmer/Lao/Myanmar dictionary line boundaries, bidi properties and rasterized StaticLayout output.
The offline signed-fixture/storage tests remain local-only and are not bundled into the public source or add-on.

Exact byte sizes, hashes and A/B/C comparisons accompany the release outside the add-on; see the release SHA256SUMS and
reproducibility report. This size reduction does not claim that an AMO service-side upload failure is resolved until AMO
actually accepts an upload.
