package suwayomi.browser;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;

/** Real JDK File.createTempFile calls, including the filesystem name-limit native. */
public final class TempFileSmoke {
    public static String verify(File parent) throws Exception {
        var created = new ArrayList<File>();
        var paths = new HashSet<String>();
        try {
            for (int i = 0; i < 8; i++) {
                File file = File.createTempFile("filters", ".tmp", parent);
                created.add(file);
                if (!file.isFile() || file.length() != 0 || !paths.add(file.getCanonicalPath())) throw new AssertionError("Temporary file creation/uniqueness failed");
                Files.writeString(file.toPath(), "fixture:" + i);
                if (!Files.readString(file.toPath()).equals("fixture:" + i)) throw new AssertionError("Temporary file I/O failed");
            }
            File longName = File.createTempFile("prefix".repeat(100), ".suffix".repeat(60), parent);
            created.add(longName);
            if (!longName.isFile() || longName.getName().length() > 255) throw new AssertionError("Filesystem name limit was not applied");
            File unicode = File.createTempFile("日本語-😀", ".tmp", parent);
            created.add(unicode);
            if (!unicode.getName().startsWith("日本語-😀")) throw new AssertionError("Unicode temporary prefix changed");
            try { File.createTempFile("ab", ".tmp", parent); throw new AssertionError("Short prefix accepted"); }
            catch (IllegalArgumentException expected) {}
            File missing = new File(parent, "temp-smoke-missing-" + System.nanoTime());
            try { File.createTempFile("filters", ".tmp", missing); throw new AssertionError("Missing parent accepted"); }
            catch (IOException expected) {}
            return "JDK temporary file creation, uniqueness, name-limit shortening, Unicode, I/O and invalid parents verified";
        } finally {
            for (File file : created) if (file.exists() && !file.delete()) throw new IOException("Could not remove test temporary file: " + file);
        }
    }
}
