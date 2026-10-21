# DEX conversion compatibility

`com/googlecode/dex2jar/ir/ts/NewTransformer.java` is based on the Apache-2.0
source from `de.femtopedia.dex2jar:dex-ir:2.4.38`:

https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-ir/2.4.38/dex-ir-2.4.38-sources.jar

Source archive SHA-256:
`5a964879137c3dd8ba4ba95c9d771c75e12e623a766cf42d0221be4a15458ec3`

The upstream control-flow/SSA tracking is retained. Two construction sites
now pass the original NEW allocation type to `ConstructorBridges`, rather
than replacing it with the owner of the invoked constructor. R8 can inline
constructors across a class hierarchy: DEX then allocates a concrete type and
invokes an ancestor constructor, a sequence not directly legal in JVM code.

The conversion-scoped registry reconstructs forwarding constructors on each
required intermediate class. Unique null `Void` marker parameters avoid
existing constructor signatures and prevent repeating already-inlined side
effects. Requests that would require modifying an external class fail. All
bridge requests are collected during IR conversion before class-file output.
Host conversion is serialized; the registry does not depend on thread-local
identity across WASM scheduler/FFI calls.

`ExtensionHost` uses dex2jar's framed in-memory output instead of ZipFS,
preserves APK resources and fixes its erroneous `java/util/Object` merge
type. A strict exception handler rejects partial conversions.

`smokeExtensions` verifies enum constants and anonymous interceptors from
the pinned published APK. A synthetic hierarchy test additionally checks
constructor signature collisions, long/double slots, multi-level forwarding
and absence of repeated side effects. The browser fixture checks actual APK
popular/search/details/chapters/QuickJS/images under extension-style CSP.
