package android.graphics;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Objects;
import suwayomi.browser.ImageCodec;

/** Local software bitmap formats over browser-local pixels and codecs. */
public final class Bitmap {
    public enum Config { ALPHA_8, RGB_565, ARGB_4444, ARGB_8888, RGBA_F16, HARDWARE, RGBA_1010102 }
    public enum CompressFormat { JPEG, PNG, WEBP, WEBP_LOSSY, WEBP_LOSSLESS }
    private int width, height;
    private final boolean mutable;
    private int[] pixels;
    private Config config;
    private boolean premultiplied = true;
    private int density;
    Bitmap(int width, int height, int[] pixels, boolean mutable) {
        this(width, height, pixels, Config.ARGB_8888, mutable);
    }
    Bitmap(int width, int height, int[] pixels, Config config, boolean mutable) {
        checkDimensions(width, height);
        if (pixels.length != width * height) throw new IllegalArgumentException("Bitmap pixel count differs");
        validateConfig(config);
        this.width = width; this.height = height; this.config = config; this.pixels = pixels; this.mutable = mutable;
        normalizePixels(pixels, config);
    }
    private static void checkDimensions(int width, int height) {
        if (width <= 0 || height <= 0 || width > 65535 || height > 65535 || (long)width * height > 8 * 1024 * 1024) throw new IllegalArgumentException("Bitmap dimensions exceed browser limits");
    }
    private void alive() { if (pixels == null) throw new IllegalStateException("Bitmap has been recycled"); }
    private void writable() { alive(); if (!mutable) throw new IllegalStateException("Bitmap is immutable"); }
    static void validateConfig(Config config) {
        Objects.requireNonNull(config, "config");
        bytesPerPixel(config);
    }
    private static int bytesPerPixel(Config config) {
        return switch (config) {
            case ALPHA_8 -> 1;
            case RGB_565, ARGB_4444 -> 2;
            case ARGB_8888 -> 4;
            case RGBA_F16, HARDWARE, RGBA_1010102 -> throw new UnsupportedOperationException("Bitmap config not implemented: " + config);
        };
    }
    private static int normalizePixel(int color, Config config) {
        return switch (config) {
            case ALPHA_8 -> color & 0xff000000;
            case RGB_565 -> {
                int red = (color >>> 19) & 0x1f;
                int green = (color >>> 10) & 0x3f;
                int blue = (color >>> 3) & 0x1f;
                yield 0xff000000 | ((red << 3) | (red >>> 2)) << 16 |
                    ((green << 2) | (green >>> 4)) << 8 | ((blue << 3) | (blue >>> 2));
            }
            case ARGB_4444 -> {
                int alpha = (color >>> 28) & 0xf, red = (color >>> 20) & 0xf;
                int green = (color >>> 12) & 0xf, blue = (color >>> 4) & 0xf;
                yield ((alpha << 4) | alpha) << 24 | ((red << 4) | red) << 16 |
                    ((green << 4) | green) << 8 | ((blue << 4) | blue);
            }
            case ARGB_8888 -> color;
            case RGBA_F16, HARDWARE, RGBA_1010102 -> throw new UnsupportedOperationException("Bitmap config not implemented: " + config);
        };
    }
    private static void normalizePixels(int[] pixels, Config config) {
        for (int index = 0; index < pixels.length; index++) pixels[index] = normalizePixel(pixels[index], config);
    }
    public static Bitmap createBitmap(int width, int height, Config config) {
        validateConfig(config); checkDimensions(width, height);
        return new Bitmap(width, height, new int[width * height], config, true);
    }
    public static Bitmap createBitmap(int[] colors, int width, int height, Config config) {
        validateConfig(config); checkDimensions(width, height);
        if (colors.length < width * height) throw new IllegalArgumentException("Insufficient bitmap colors");
        return new Bitmap(width, height, Arrays.copyOf(colors, width * height), config, false);
    }
    public static Bitmap createBitmap(Bitmap source, int x, int y, int width, int height) {
        Objects.requireNonNull(source); source.alive();
        if (width <= 0 || height <= 0 || x < 0 || y < 0 || (long)x + width > source.width || (long)y + height > source.height)
            throw new IllegalArgumentException("Invalid bitmap crop rectangle");
        if (x == 0 && y == 0 && width == source.width && height == source.height && !source.mutable) return source;
        checkDimensions(width, height);
        int[] cropped = new int[Math.multiplyExact(width, height)];
        for (int row = 0; row < height; row++)
            System.arraycopy(source.pixels, (y + row) * source.width + x, cropped, row * width, width);
        Bitmap result = new Bitmap(width, height, cropped, source.config, false);
        result.density = source.density;
        result.premultiplied = source.premultiplied;
        return result;
    }
    public int getWidth() { return width; }
    public int getHeight() { return height; }
    public Config getConfig() { alive(); return config; }
    public int getByteCount() { alive(); return Math.multiplyExact(Math.multiplyExact(width, height), bytesPerPixel(config)); }
    public int getAllocationByteCount() { alive(); return Math.multiplyExact(pixels.length, bytesPerPixel(config)); }
    public int getRowBytes() { alive(); return Math.multiplyExact(width, bytesPerPixel(config)); }
    public boolean isPremultiplied() { alive(); return premultiplied; }
    public void setPremultiplied(boolean premultiplied) { alive(); this.premultiplied = premultiplied; }
    public int getDensity() { alive(); return density; }
    public void setDensity(int density) { alive(); this.density = density; }
    public int getScaledWidth(int targetDensity) { alive(); return scaleFromDensity(width, density, targetDensity); }
    public int getScaledHeight(int targetDensity) { alive(); return scaleFromDensity(height, density, targetDensity); }
    static int scaleFromDensity(int size, int sourceDensity, int targetDensity) {
        if (sourceDensity <= 0 || targetDensity <= 0 || sourceDensity == targetDensity) return size;
        long scaled = ((long)size * targetDensity + (sourceDensity >> 1)) / sourceDensity;
        if (scaled > Integer.MAX_VALUE) throw new IllegalArgumentException("Density-scaled bitmap dimension exceeds integer bounds");
        return (int)Math.max(size == 0 ? 0 : 1, scaled);
    }
    public boolean isMutable() { return pixels != null && mutable; }
    public boolean isRecycled() { return pixels == null; }
    public void recycle() { pixels = null; }
    public void prepareToDraw() { alive(); }
    private int position(int x, int y) {
        alive(); if (x < 0 || y < 0 || x >= width || y >= height) throw new IllegalArgumentException("Pixel outside bitmap");
        return y * width + x;
    }
    public int getPixel(int x, int y) { return pixels[position(x, y)]; }
    public void setPixel(int x, int y, int color) { writable(); pixels[position(x, y)] = normalizePixel(color, config); }
    public void eraseColor(int color) { writable(); Arrays.fill(pixels, normalizePixel(color, config)); }
    public Bitmap copy(Config config, boolean mutable) {
        validateConfig(config); alive();
        Bitmap copy = new Bitmap(width, height, Arrays.copyOf(pixels, width * height), config, mutable);
        copy.density = density;
        copy.premultiplied = premultiplied;
        return copy;
    }
    void replaceDecodedPixels(int width, int height, int[] decoded, int density, Config config, boolean premultiplied) {
        writable(); checkDimensions(width, height);
        validateConfig(config);
        if (config != this.config) throw new IllegalArgumentException("inBitmap config differs from decoded config");
        int count = Math.multiplyExact(width, height);
        if (decoded.length != count || count > pixels.length) throw new IllegalArgumentException("inBitmap allocation is too small for decoded image");
        for (int index = 0; index < count; index++) pixels[index] = normalizePixel(decoded[index], config);
        this.width = width; this.height = height; this.density = density;
        this.premultiplied = premultiplied;
    }
    private void window(int[] colors, int offset, int stride, int x, int y, int w, int h) {
        alive(); Objects.requireNonNull(colors);
        if (w < 0 || h < 0 || x < 0 || y < 0 || (long)x + w > width || (long)y + h > height || Math.abs((long)stride) < w) throw new IllegalArgumentException("Invalid bitmap pixel rectangle");
        if (w == 0 || h == 0) return;
        long last = (long)offset + (long)(h - 1) * stride;
        if (Math.min(offset, last) < 0 || Math.max(offset, last) + w > colors.length) throw new ArrayIndexOutOfBoundsException("Invalid bitmap pixel array window");
    }
    public void getPixels(int[] colors, int offset, int stride, int x, int y, int w, int h) {
        window(colors, offset, stride, x, y, w, h);
        if (w == 0 || h == 0) return;
        for (int row = 0; row < h; row++) System.arraycopy(pixels, (y + row) * width + x, colors, offset + row * stride, w);
    }
    public void setPixels(int[] colors, int offset, int stride, int x, int y, int w, int h) {
        writable(); window(colors, offset, stride, x, y, w, h);
        if (w == 0 || h == 0) return;
        for (int row = 0; row < h; row++) for (int column = 0; column < w; column++)
            pixels[(y + row) * width + x + column] = normalizePixel(colors[offset + row * stride + column], config);
    }
    public boolean compress(CompressFormat format, int quality, OutputStream stream) {
        alive(); Objects.requireNonNull(format); Objects.requireNonNull(stream);
        if (quality < 0 || quality > 100) throw new IllegalArgumentException("Invalid bitmap compression quality");
        String mime = switch (format) {
            case PNG -> "image/png";
            case JPEG -> "image/jpeg";
            case WEBP, WEBP_LOSSY, WEBP_LOSSLESS -> "image/webp";
        };
        try { stream.write(ImageCodec.encode(width, height, Arrays.copyOf(pixels, width * height), mime, quality)); return true; }
        catch (IOException error) { return false; }
    }
}
