package suwayomi.browser;

import java.io.InputStream;
import java.net.URI;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;

/** Exercises the actual bootstrap resource and module-image paths in the guest JVM. */
public final class RuntimeResourceProbe {
    private interface Probe { String run() throws Throwable; }
    private static String check(Probe probe) {
        try { return "ok:" + probe.run(); }
        catch (Throwable error) { return "error:" + error.getClass().getName() + ":" + error.getMessage(); }
    }
    private static String classBytes(InputStream stream) throws Exception {
        if (stream == null) throw new IllegalStateException("Missing class resource");
        try (stream) {
            byte[] bytes = stream.readAllBytes();
            if (bytes.length < 4 || bytes[0] != (byte)0xca || bytes[1] != (byte)0xfe || bytes[2] != (byte)0xba || bytes[3] != (byte)0xbe)
                throw new IllegalStateException("Invalid class resource");
            return "class-bytes=" + bytes.length;
        }
    }
    public static String run() {
        JSONObject result = new JSONObject();
        result.put("moduleImagePresent", Files.isRegularFile(Path.of(System.getProperty("java.home"), "lib/modules")));
        result.put("classResource", check(() -> classBytes(Object.class.getResourceAsStream("/java/lang/Object.class"))));
        result.put("moduleResource", check(() -> classBytes(Object.class.getModule().getResourceAsStream("java/lang/Object.class"))));
        result.put("moduleLayer", check(() -> "boot-modules=" + ModuleLayer.boot().modules().size()));
        result.put("jrt", check(() -> {
            var file = FileSystems.getFileSystem(URI.create("jrt:/")).getPath("/modules/java.base/java/lang/Object.class");
            return classBytes(Files.newInputStream(file));
        }));
        result.put("normalization", check(() -> java.text.Normalizer.normalize("é", java.text.Normalizer.Form.NFC)));
        result.put("zoneData", check(() -> java.time.ZoneId.of("Asia/Tokyo").getRules().getOffset(java.time.Instant.EPOCH).toString()));
        return result.toString();
    }
}
