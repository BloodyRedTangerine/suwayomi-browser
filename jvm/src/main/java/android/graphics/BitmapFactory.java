package android.graphics;

import java.io.IOException;
import java.io.InputStream;
import java.io.FileInputStream;
import java.util.Arrays;
import java.util.Objects;
import suwayomi.browser.ImageCodec;

public final class BitmapFactory {
    public static Bitmap decodeStream(InputStream stream) { return decodeStream(stream, null, null); }
    public static Bitmap decodeStream(InputStream stream, Rect outPadding, Options options) {
        if (stream == null) return null;
        try {
            byte[] bytes = stream.readNBytes(16 * 1024 * 1024 + 1);
            return decodeByteArray(bytes, 0, bytes.length, options);
        } catch (IOException invalid) { return null; }
    }
    public static Bitmap decodeFile(String path) { return decodeFile(path, null); }
    public static Bitmap decodeFile(String path, Options options) {
        try (InputStream stream = new FileInputStream(path)) { return decodeStream(stream, null, options); }
        catch (IOException invalid) { return null; }
    }
    public static class Options {
        public boolean inJustDecodeBounds, inMutable;
        public boolean inScaled = true, inPremultiplied = true;
        public int inSampleSize = 1, inDensity, inTargetDensity, inScreenDensity;
        public int outWidth = -1, outHeight = -1;
        public String outMimeType;
        public Bitmap.Config inPreferredConfig = Bitmap.Config.ARGB_8888;
        public Bitmap inBitmap;
    }
    public static Bitmap decodeByteArray(byte[] data, int offset, int length) { return decodeByteArray(data, offset, length, null); }
    public static Bitmap decodeByteArray(byte[] data, int offset, int length, Options options) {
        Objects.requireNonNull(data);
        if (offset < 0 || length < 0 || (long)offset + length > data.length) throw new ArrayIndexOutOfBoundsException();
        if (length > 16 * 1024 * 1024) throw new IllegalArgumentException("Encoded image exceeds 16 MiB browser limit");
        if (options != null) {
            options.outWidth = options.outHeight = -1; options.outMimeType = null;
            Bitmap.validateConfig(options.inPreferredConfig);
            if (options.inDensity < 0 || options.inTargetDensity < 0 || options.inScreenDensity < 0) throw new IllegalArgumentException("Bitmap densities must be non-negative");
        }
        try {
            boolean bounds = options != null && options.inJustDecodeBounds;
            ImageCodec.Decoded decoded = ImageCodec.decode(Arrays.copyOfRange(data, offset, offset + length), bounds);
            if (options != null) { options.outWidth = decoded.width(); options.outHeight = decoded.height(); options.outMimeType = decoded.mime(); }
            if (bounds) return null;
            int sample = options == null ? 1 : Math.max(1, options.inSampleSize);
            int width = (int)(((long)decoded.width() + sample - 1) / sample);
            int height = (int)(((long)decoded.height() + sample - 1) / sample);
            int[] pixels;
            if (sample == 1) pixels = decoded.pixels();
            else {
                pixels = new int[Math.multiplyExact(width, height)];
                for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) pixels[y * width + x] = decoded.pixels()[Math.min(decoded.height() - 1, y * sample) * decoded.width() + Math.min(decoded.width() - 1, x * sample)];
            }
            int density = options == null ? 0 : options.inDensity;
            if (options != null && options.inScaled && options.inDensity > 0 && options.inTargetDensity > 0
                && options.inDensity != options.inTargetDensity && options.inDensity != options.inScreenDensity) {
                int scaledWidth = Bitmap.scaleFromDensity(width, options.inDensity, options.inTargetDensity);
                int scaledHeight = Bitmap.scaleFromDensity(height, options.inDensity, options.inTargetDensity);
                pixels = scalePixels(pixels, width, height, scaledWidth, scaledHeight);
                width = scaledWidth; height = scaledHeight; density = options.inTargetDensity;
            }
            Bitmap reuse = options == null ? null : options.inBitmap;
            if (reuse != null) {
                if (reuse.isRecycled() || !reuse.isMutable()) throw new IllegalArgumentException("inBitmap must be a mutable, unrecycled bitmap");
                reuse.replaceDecodedPixels(width, height, pixels, density,
                    options.inPreferredConfig, options.inPremultiplied);
                return reuse;
            }
            Bitmap.Config config = options == null ? Bitmap.Config.ARGB_8888 : options.inPreferredConfig;
            Bitmap result = new Bitmap(width, height, pixels, config, options != null && options.inMutable);
            if (options != null) result.setPremultiplied(options.inPremultiplied);
            result.setDensity(density);
            return result;
        } catch (IOException invalid) { return null; }
    }

    private static int[] scalePixels(int[] pixels, int width, int height, int scaledWidth, int scaledHeight) {
        Bitmap source = new Bitmap(width, height, pixels, true);
        Bitmap scaled = Bitmap.createBitmap(scaledWidth, scaledHeight, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(scaled);
        canvas.drawBitmap(source, new Rect(0, 0, width, height), new Rect(0, 0, scaledWidth, scaledHeight), new Paint(Paint.FILTER_BITMAP_FLAG));
        int[] result = new int[Math.multiplyExact(scaledWidth, scaledHeight)];
        scaled.getPixels(result, 0, scaledWidth, 0, 0, scaledWidth, scaledHeight);
        return result;
    }
}
