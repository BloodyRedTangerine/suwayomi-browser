package suwayomi.browser;

import java.io.IOException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.Base64;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.LinkOption;
import org.json.JSONObject;

/** RGBA bytes cross only the local JVM/worker boundary, never a network service. */
public final class ImageCodec {
    public record Decoded(int width, int height, String mime, int[] pixels) {}
    private static final Path BUFFER_ROOT = Path.of("/cache/image-codec");
    private static boolean binary() { return Boolean.getBoolean("suwayomi.browser.binaryImages"); }
    private static Path writeBuffer(byte[] bytes) throws IOException {
        if (!Files.isDirectory(Path.of("/cache"), LinkOption.NOFOLLOW_LINKS)
            || !Files.isDirectory(BUFFER_ROOT, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid local image cache");
        Path file = File.createTempFile("jvm-image-", ".bin", BUFFER_ROOT.toFile()).toPath();
        try (var output = new FileOutputStream(file.toFile())) { output.write(bytes); return file; }
        catch (IOException | RuntimeException error) { file.toFile().delete(); throw error; }
    }
    private static byte[] readBuffer(JSONObject response, int maximum) throws IOException {
        String name = response.getString("bodyFile");
        if (!name.matches("/cache/image-codec/(?:jvm|js)-image-[A-Za-z0-9-]+\\.bin")) throw new IOException("Invalid local image buffer path");
        Path file = Path.of(name);
        try {
            if (!Files.isDirectory(Path.of("/cache"), LinkOption.NOFOLLOW_LINKS)
                || !Files.isDirectory(BUFFER_ROOT, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid local image cache");
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid local image buffer");
            long size = Files.size(file);
            if (size <= 0 || size > maximum) throw new IOException("Local image buffer exceeds limit");
            byte[] bytes;
            try (var input = new FileInputStream(file.toFile())) { bytes = input.readNBytes((int)size + 1); }
            if (bytes.length != size || response.getLong("byteLength") != size) throw new IOException("Local image buffer size mismatch");
            return bytes;
        } finally { file.toFile().delete(); }
    }
    private static JSONObject exchange(JSONObject command, byte[] bytes, boolean useBinary) throws IOException {
        if (!useBinary) return call(command.put("body", Base64.getEncoder().encodeToString(bytes)));
        Path input = writeBuffer(bytes);
        try { return call(command.put("binary", true).put("bodyFile", input.toString())); }
        finally { input.toFile().delete(); }
    }
    private static JSONObject call(JSONObject command) throws IOException {
        JSONObject response = new JSONObject(BrowserTransport.image(command.toString()));
        if (response.has("error")) throw new IOException(response.getString("error"));
        return response;
    }
    public static Decoded decode(byte[] bytes, boolean boundsOnly) throws IOException {
        if (bytes.length > 16 * 1024 * 1024) throw new IOException("Encoded image exceeds browser limit");
        boolean useBinary = binary();
        JSONObject response = exchange(new JSONObject().put("action", "decode").put("boundsOnly", boundsOnly), bytes, useBinary);
        int width = response.getInt("width"), height = response.getInt("height");
        long count = (long)width * height;
        if (width <= 0 || height <= 0 || count > 8 * 1024 * 1024) throw new IOException("Invalid browser bitmap dimensions");
        int[] pixels = null;
        if (!boundsOnly) {
            byte[] rgba = useBinary ? readBuffer(response, Math.multiplyExact((int)count, 4)) : Base64.getDecoder().decode(response.getString("body"));
            if (rgba.length != count * 4) throw new IOException("Invalid browser RGBA byte count");
            pixels = new int[(int)count];
            for (int i = 0; i < pixels.length; i++) {
                int p = i * 4;
                pixels[i] = (rgba[p + 3] & 255) << 24 | (rgba[p] & 255) << 16 | (rgba[p + 1] & 255) << 8 | rgba[p + 2] & 255;
            }
        }
        return new Decoded(width, height, response.getString("mime"), pixels);
    }
    public static byte[] encode(int width, int height, int[] pixels, String mime, int quality) throws IOException {
        if (width <= 0 || height <= 0 || width > 65535 || height > 65535 || (long)width * height != pixels.length || pixels.length > 8 * 1024 * 1024) throw new IOException("Invalid bitmap encoding dimensions");
        byte[] rgba = new byte[Math.multiplyExact(pixels.length, 4)];
        for (int i = 0; i < pixels.length; i++) {
            int color = pixels[i], p = i * 4;
            rgba[p] = (byte)(color >>> 16); rgba[p + 1] = (byte)(color >>> 8); rgba[p + 2] = (byte)color; rgba[p + 3] = (byte)(color >>> 24);
        }
        boolean useBinary = binary();
        JSONObject response = exchange(new JSONObject().put("action", "encode").put("width", width).put("height", height).put("mime", mime).put("quality", quality), rgba, useBinary);
        if (!mime.equals(response.getString("mime"))) throw new IOException("Browser image format mismatch");
        return useBinary ? readBuffer(response, 16 * 1024 * 1024) : Base64.getDecoder().decode(response.getString("body"));
    }
}
