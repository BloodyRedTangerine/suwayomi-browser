// Packaging invariants for the shared JIMAGE and build-time host subset.
export function assertRuntimeInventory({ runtimeFiles, hostEntries }) {
  const files = new Set(runtimeFiles), entries = new Set(hostEntries);
  if (files.has('jdk23.jar')) throw new Error('Obsolete duplicate JDK JAR: rerun prepare:runtime');
  if (!files.has('jdk23/lib/modules')) throw new Error('Shared JDK module image missing');
  for (const entry of entries) {
    if (entry.endsWith('/') || entry.endsWith('.class')) continue; // Directories and Java packages are not Android assets.
    if (/^(?:res\/|jni\/|assets\/|resources\.arsc$)/.test(entry)) throw new Error('Unusable Android framework asset: ' + entry);
  }
  for (const entry of ['com/ibm/icu/text/BreakIterator.class', 'com/ibm/icu/text/Normalizer2.class',
    'com/ibm/icu/text/RuleBasedCollator.class',
    'META-INF/services/sun.util.resources.LocaleData$CommonResourceBundleProvider']) {
    if (!entries.has(entry)) throw new Error('Required runtime entry missing: ' + entry);
  }
}
