package suwayomi.browser;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import java.util.zip.*;

/** Conservative class-level closure of the ICU APIs referenced by the host.
 * Keep all locale break dictionaries and collations: removing those would silently
 * change segmentation/search on languages not represented in a small test corpus.
 * Exclude unrelated formatting/transliteration bundles, not language coverage.
 */
final class IcuSubset {
    private static final String PREFIX = "com/ibm/icu/";
    private static final String DATA = PREFIX + "impl/data/icudata/";
    private static final Pattern REFERENCE = Pattern.compile("com[/\\.]ibm[/\\.]icu[/\\.][A-Za-z0-9_$/.]+");
    private final Set<String> classes = new TreeSet<>();
    private int removedClasses, removedData;

    IcuSubset(Path jar) throws IOException {
        Map<String, Set<String>> edges = new TreeMap<>();
        Set<String> roots = new TreeSet<>();
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            for (ZipEntry entry : Collections.list(zip.entries())) {
                if (!entry.getName().endsWith(".class")) continue;
                Set<String> refs = references(zip.getInputStream(entry).readAllBytes());
                if (entry.getName().startsWith(PREFIX)) edges.put(entry.getName().substring(0, entry.getName().length()-6), refs);
                else roots.addAll(refs);
            }
        }
        // ICU creates these services reflectively. Keep the whole services' class
        // closure (including nested classes), rather than relying on test traces.
        roots.add(PREFIX + "text/BreakIteratorFactory");
        roots.add(PREFIX + "text/CollatorServiceShim");
        ArrayDeque<String> pending = new ArrayDeque<>(roots);
        while (!pending.isEmpty()) {
            String name = pending.removeFirst();
            if (!edges.containsKey(name) || !classes.add(name)) continue;
            pending.addAll(edges.get(name));
        }
    }

    private static Set<String> references(byte[] bytes) throws IOException {
        Set<String> refs = new TreeSet<>();
        // Read every constant-pool UTF8, including descriptors, signatures and
        // reflective class-name strings. No bytecode implementation is rewritten.
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes));
        if (in.readInt() != 0xcafebabe) throw new IOException("Invalid class file");
        in.readInt(); int count = in.readUnsignedShort();
        for (int i=1; i<count; i++) {
            int tag = in.readUnsignedByte();
            switch (tag) {
                case 1 -> {
                    Matcher matcher = REFERENCE.matcher(in.readUTF());
                    while (matcher.find()) {
                        String value = matcher.group().replace('.', '/');
                        while (value.endsWith("/")) value = value.substring(0,value.length()-1);
                        refs.add(value);
                    }
                }
                case 3, 4, 9, 10, 11, 12, 17, 18 -> in.skipNBytes(4);
                case 5, 6 -> { in.skipNBytes(8); i++; }
                case 7, 8, 16, 19, 20 -> in.skipNBytes(2);
                case 15 -> in.skipNBytes(3);
                default -> throw new IOException("Unknown constant pool tag " + tag);
            }
        }
        return refs;
    }

    boolean keep(String name) {
        if (!name.startsWith(PREFIX)) return true;
        if (name.endsWith(".class")) {
            boolean keep = classes.contains(name.substring(0,name.length()-6));
            if (!keep) removedClasses++;
            return keep;
        }
        if (!name.startsWith(DATA)) return true; // config + license files
        String relative = name.substring(DATA.length());
        boolean keep = relative.startsWith("brkitr/") || relative.startsWith("coll/") ||
            relative.endsWith(".icu") || relative.endsWith(".nrm") ||
            Set.of("root.res", "pool.res", "res_index.res", "likelySubtags.res", "metadata.res",
                "supplementalData.res", "langInfo.res", "keyTypeData.res").contains(relative);
        if (!keep) removedData++;
        return keep;
    }

    void report() {
        System.out.println("ICU subset: retained " + classes.size() + " reachable classes; excluded " +
            removedClasses + " classes and " + removedData + " unrelated data entries");
    }
}
