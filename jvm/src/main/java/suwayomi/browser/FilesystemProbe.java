package suwayomi.browser;

import android.content.Context;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;

/** Executed only by the isolated browser filesystem harness, not native smoke. */
public final class FilesystemProbe {
    public static String run(String action) throws Exception {
        var context = new Context();
        var directory = context.getDir("state-fixture", Context.MODE_PRIVATE);
        var preferences = context.getSharedPreferences("filesystem-fixture", 0);
        if (action.equals("tempFiles")) return TempFileSmoke.verify(context.getCacheDir());
        if (action.equals("randomWrite")) return RandomAccessProbe.write();
        if (action.equals("randomVerify")) return RandomAccessProbe.verify();
        if (action.equals("fileOnly")) {
            String marker = "file-only:" + System.nanoTime();
            Files.writeString(context.getFileStreamPath("filesystem-extra.txt").toPath(), marker);
            return marker;
        }
        if (action.equals("verifyExtra")) return Files.readString(context.getFileStreamPath("filesystem-extra.txt").toPath());
        if (action.equals("write")) {
            try (var out = context.openFileOutput("browser-file-state.bin", Context.MODE_APPEND)) { out.write(99); }
            try (var out = context.openFileOutput("browser-file-state.bin", Context.MODE_PRIVATE)) { out.write(new byte[]{9, 0, (byte)128, (byte)255, 9}, 1, 3); }
            try (var out = context.openFileOutput("browser-file-state.bin", Context.MODE_APPEND)) { out.write(7); }
            if (!new File(directory, "empty").mkdirs() && !new File(directory, "empty").isDirectory()) throw new AssertionError("Empty directory creation failed");
            var source = new File(directory, "before.txt");
            Files.writeString(source.toPath(), "Persistent Unicode: 日本語");
            var renamed = new File(directory, "renamed.txt");
            if (renamed.exists() && !renamed.delete()) throw new AssertionError("Old fixture rename target could not be replaced");
            if (!source.renameTo(renamed)) throw new AssertionError("Guest rename failed");
            Files.writeString(new File(context.getCacheDir(), "filesystem-volatile.txt").toPath(), "not durable");
            try (var out = context.openFileOutput("filesystem-deleted.txt", Context.MODE_PRIVATE)) { out.write(1); }
            if (!context.deleteFile("filesystem-deleted.txt")) throw new AssertionError("Guest deletion failed");
            for (String name : new String[]{"Café.txt", "日本語.txt", "emoji-😀.txt", ".hidden"}) {
                File prior = context.getFileStreamPath(name);
                if (prior.exists() && !prior.setWritable(true, false)) throw new AssertionError("Fixture file permissions could not be reset");
                try (var out = context.openFileOutput(name, Context.MODE_PRIVATE)) { out.write(new byte[]{0, (byte)255}); }
            }
            File unicodeDir = context.getDir("目录😀", 0);
            Files.writeString(new File(unicodeDir, "résumé.txt").toPath(), "Unicode path content");
            File metadata = context.getFileStreamPath("Café.txt");
            if (!metadata.setLastModified(1700000000123L) || metadata.lastModified() != 1700000000123L) throw new AssertionError("Java millisecond timestamp API failed: " + metadata.lastModified());
            if (!metadata.setExecutable(true, true) || !metadata.setReadable(true, false) || !metadata.setWritable(false, false) || !metadata.setWritable(true, true)) throw new AssertionError("Java permission API failed");
            if (!context.getFileStreamPath("emoji-😀.txt").setReadOnly()) throw new AssertionError("Java read-only API failed");
            verifyDirectory(context, directory, false);
            preferences.edit().putBoolean("directoryFixture", true).commit();
            preferences.edit().putBoolean("mustRestore", true).putLong("large", Long.MAX_VALUE).commit();
            return "Guest Java binary/append/rename/delete/empty-directory files and typed preferences written";
        }
        if (action.equals("verifyCold")) {
            try (var input = context.openFileInput("browser-file-state.bin")) {
                if (!Arrays.equals(input.readAllBytes(), new byte[]{0, (byte)128, (byte)255, 7})) throw new AssertionError("Persistent binary bytes lost");
                if (input.read(new byte[0]) != 0) throw new AssertionError("Zero-length read at EOF did not return zero");
                if (input.skip(-3) != -3 || input.read() != 128 || input.available() != 2) throw new AssertionError("File seeking/unsigned bytes/available failed");
            }
            if (!Files.readString(new File(directory, "renamed.txt").toPath()).equals("Persistent Unicode: 日本語") || new File(directory, "before.txt").exists()) throw new AssertionError("Persistent rename/text lost");
            if (!new File(directory, "empty").isDirectory() || context.getFileStreamPath("filesystem-deleted.txt").exists()) throw new AssertionError("Empty directory/deletion lost");
            if (new File(context.getCacheDir(), "filesystem-volatile.txt").exists()) throw new AssertionError("Disposable cache unexpectedly restored");
            if (!preferences.getBoolean("mustRestore", false) || preferences.getLong("large", 0) != Long.MAX_VALUE) throw new AssertionError("Files/preferences were not restored together");
            if (preferences.getBoolean("directoryFixture", false)) verifyDirectory(context, directory, true);
            if (preferences.getBoolean("randomFixture", false)) RandomAccessProbe.verify();
            return "Cold Java files, rename/delete, empty directory, typed Long and temporary cache verified";
        }
        throw new IllegalArgumentException("Unknown filesystem probe action");
    }
    private static void verifyDirectory(Context context, File directory, boolean cold) throws Exception {
        var names = new java.util.HashSet<>(Arrays.asList(context.fileList()));
        for (String name : new String[]{"browser-file-state.bin", "Café.txt", "日本語.txt", "emoji-😀.txt", ".hidden", "app_目录😀"}) {
            if (!names.contains(name)) throw new AssertionError("Directory listing lost filename: " + name + "; actual=" + names);
        }
        if (names.contains(".") || names.contains("..") || names.contains("filesystem-deleted.txt")) throw new AssertionError("Invalid directory listing entries");
        if (!new File("/").getCanonicalPath().equals("/") || !new File(context.getFilesDir(), "app_目录😀/../日本語.txt").getCanonicalPath().equals(context.getFileStreamPath("日本語.txt").getAbsolutePath())) throw new AssertionError("Unicode/root lexical canonicalization failed");
        if (new File(directory, "empty").list().length != 0) throw new AssertionError("Empty directory listing failed");
        if (context.getFileStreamPath("browser-file-state.bin").list() != null || new File(directory, "missing").list() != null) throw new AssertionError("File.list I/O failure must return null");
        try (var ignored = context.openFileInput("不存在-😀.bin")) { throw new AssertionError("Missing Unicode file unexpectedly opened"); }
        catch (java.io.FileNotFoundException expected) { if (!expected.getMessage().equals(context.getFileStreamPath("不存在-😀.bin").getPath())) throw new AssertionError("Unicode input error lost its path"); }
        File missingOutput = new File(context.getFilesDir(), "不存在😀/missing.bin");
        try (var ignored = new java.io.FileOutputStream(missingOutput)) { throw new AssertionError("Missing Unicode output directory unexpectedly opened"); }
        catch (java.io.FileNotFoundException expected) { if (!expected.getMessage().equals(missingOutput.getPath())) throw new AssertionError("Unicode output error lost its path"); }
        try { Files.readString(context.getFileStreamPath("缺失😀.txt").toPath()); throw new AssertionError("Missing NIO path unexpectedly opened"); }
        catch (java.nio.file.NoSuchFileException expected) { if (!expected.getMessage().contains("缺失😀.txt")) throw new AssertionError("Unicode NIO error lost its path"); }
        var missingPath = context.getFileStreamPath("缺失😀.txt").toPath();
        if (Files.exists(missingPath) || Files.exists(missingPath, java.nio.file.LinkOption.NOFOLLOW_LINKS) || Files.isReadable(missingPath)) throw new AssertionError("Missing NIO path reported existing/readable");
        try { Files.readAttributes(missingPath, java.nio.file.attribute.BasicFileAttributes.class, java.nio.file.LinkOption.NOFOLLOW_LINKS); throw new AssertionError("Missing lstat unexpectedly succeeded"); }
        catch (java.nio.file.NoSuchFileException expected) { /* typed errno retained */ }
        try (var ignored = Files.newOutputStream(context.getFileStreamPath("Café.txt").toPath(), java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE)) { throw new AssertionError("Exclusive create overwrote a file"); }
        catch (java.nio.file.FileAlreadyExistsException expected) { if (!expected.getFile().endsWith("Café.txt")) throw new AssertionError("Existing-file error lost Unicode path"); }
        for (String name : new String[]{"Café.txt", "日本語.txt", "emoji-😀.txt"}) {
            try (var input = context.openFileInput(name)) { if (!Arrays.equals(input.readAllBytes(), new byte[]{0, (byte)255})) throw new AssertionError("Unicode filename bytes lost: " + name); }
        }
        File unicodeDir = context.getDir("目录😀", 0);
        if (!Arrays.asList(unicodeDir.list()).contains("résumé.txt") || !Files.readString(new File(unicodeDir, "résumé.txt").toPath()).equals("Unicode path content")) throw new AssertionError("Unicode directory path lost");
        if (cold && context.getFileStreamPath("Café.txt").lastModified() != 1700000000000L) throw new AssertionError("Checkpoint second-resolution timestamp lost");
    }
    public static void constructorCheck() {
        if (new Context().getSharedPreferences("filesystem-fixture", 0).getBoolean("mustRestore", false)) {
            try { run("verifyCold"); } catch (Exception error) { throw new IllegalStateException("Files not restored before source constructor", error); }
        }
    }
}
