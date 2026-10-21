package suwayomi.browser;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.Base64;

/** Browser-only codec checks against an independent four-color PNG fixture. */
public final class GraphicsProbe {
    public static String verify() throws Exception {
        byte[] png = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4zwBEIAikwQAAScgJ94C76UsAAAAASUVORK5CYII=");
        int[] expected = {0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff};
        var options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        if (BitmapFactory.decodeByteArray(png, 0, png.length, options) != null || options.outWidth != 2 || options.outHeight != 2 || !"image/png".equals(options.outMimeType)) throw new AssertionError("Bitmap bounds-only decode failed");
        byte[] padded = new byte[png.length + 9]; System.arraycopy(png, 0, padded, 4, png.length);
        Bitmap decoded = BitmapFactory.decodeByteArray(padded, 4, png.length);
        if (decoded == null || decoded.getWidth() != 2 || decoded.getHeight() != 2 || decoded.isMutable()) throw new AssertionError("Immutable bitmap decode failed");
        int[] actual = new int[4]; decoded.getPixels(actual, 0, 2, 0, 0, 2, 2);
        if (!Arrays.equals(actual, expected)) throw new AssertionError("RGBA/ARGB channel order or PNG pixel values differ: " + Arrays.toString(actual));
        var sampledOptions = new BitmapFactory.Options(); sampledOptions.inSampleSize = 2;
        Bitmap sampled = BitmapFactory.decodeByteArray(padded, 4, png.length, sampledOptions);
        if (sampled == null || sampled.getWidth() != 1 || sampled.getHeight() != 1 || sampled.getPixel(0, 0) != expected[0] || sampledOptions.outWidth != 2 || sampledOptions.outHeight != 2)
            throw new AssertionError("Bitmap inSampleSize decode failed");
        sampled.recycle();

        Bitmap rgb565 = Bitmap.createBitmap(new int[]{0x80123456}, 1, 1, Bitmap.Config.RGB_565);
        if (rgb565.getConfig() != Bitmap.Config.RGB_565 || rgb565.getPixel(0, 0) != 0xff103452 ||
            rgb565.getRowBytes() != 2 || rgb565.getByteCount() != 2 || rgb565.getAllocationByteCount() != 2)
            throw new AssertionError("RGB_565 quantization, alpha, or storage metrics failed");
        Bitmap rgb565Mutable = Bitmap.createBitmap(2, 1, Bitmap.Config.RGB_565);
        if (rgb565Mutable.getPixel(0, 0) != 0xff000000) throw new AssertionError("RGB_565 bitmap was not initialized to opaque black");
        rgb565Mutable.setPixel(1, 0, 0x00123456);
        if (rgb565Mutable.getPixel(1, 0) != 0xff103452) throw new AssertionError("RGB_565 setPixel did not quantize");
        Bitmap alpha8 = Bitmap.createBitmap(new int[]{0x80123456}, 1, 1, Bitmap.Config.ALPHA_8);
        if (alpha8.getPixel(0, 0) != 0x80000000 || alpha8.getByteCount() != 1 || alpha8.getRowBytes() != 1)
            throw new AssertionError("ALPHA_8 did not preserve alpha-only pixels or byte metrics");
        Bitmap alpha8Mutable = Bitmap.createBitmap(1, 1, Bitmap.Config.ALPHA_8);
        alpha8Mutable.setPixel(0, 0, 0x7fabcdef);
        if (alpha8Mutable.getPixel(0, 0) != 0x7f000000) throw new AssertionError("ALPHA_8 setPixel retained color channels");
        Bitmap argb4444 = Bitmap.createBitmap(new int[]{0x9a26b3fd}, 1, 1, Bitmap.Config.ARGB_4444);
        if (argb4444.getPixel(0, 0) != 0x9922bbff || argb4444.getByteCount() != 2 || argb4444.getRowBytes() != 2)
            throw new AssertionError("ARGB_4444 channel quantization or byte metrics failed");
        Bitmap widenedCopy = rgb565.copy(Bitmap.Config.ARGB_8888, true);
        if (widenedCopy.getConfig() != Bitmap.Config.ARGB_8888 || widenedCopy.getPixel(0, 0) != 0xff103452 || widenedCopy.getRowBytes() != 4)
            throw new AssertionError("Bitmap copy did not convert the requested software config");

        var rgbDecodeOptions = new BitmapFactory.Options(); rgbDecodeOptions.inPreferredConfig = Bitmap.Config.RGB_565;
        Bitmap rgbDecoded = BitmapFactory.decodeByteArray(png, 0, png.length, rgbDecodeOptions);
        if (rgbDecoded == null || rgbDecoded.getConfig() != Bitmap.Config.RGB_565 || rgbDecoded.getByteCount() != 8 ||
            rgbDecoded.getPixel(0, 0) != expected[0] || rgbDecoded.getPixel(1, 0) != expected[1])
            throw new AssertionError("BitmapFactory RGB_565 decoding failed");
        byte[] alphaPng = ImageCodec.encode(2, 1, new int[]{0x80123456, 0x40000000}, "image/png", 100);
        var alphaDecodeOptions = new BitmapFactory.Options();
        alphaDecodeOptions.inPreferredConfig = Bitmap.Config.ALPHA_8; alphaDecodeOptions.inPremultiplied = false;
        Bitmap alphaDecoded = BitmapFactory.decodeByteArray(alphaPng, 0, alphaPng.length, alphaDecodeOptions);
        if (alphaDecoded == null || alphaDecoded.getConfig() != Bitmap.Config.ALPHA_8 || alphaDecoded.isPremultiplied() ||
            alphaDecoded.getPixel(0, 0) != 0x80000000 || alphaDecoded.getPixel(1, 0) != 0x40000000 || alphaDecoded.getByteCount() != 2)
            throw new AssertionError("BitmapFactory ALPHA_8 or unpremultiplied decode failed");
        Bitmap rgbReuse = Bitmap.createBitmap(4, 4, Bitmap.Config.RGB_565);
        var rgbReuseOptions = new BitmapFactory.Options();
        rgbReuseOptions.inPreferredConfig = Bitmap.Config.RGB_565; rgbReuseOptions.inBitmap = rgbReuse; rgbReuseOptions.inSampleSize = 2;
        if (BitmapFactory.decodeByteArray(png, 0, png.length, rgbReuseOptions) != rgbReuse ||
            rgbReuse.getConfig() != Bitmap.Config.RGB_565 || rgbReuse.getWidth() != 1 || rgbReuse.getHeight() != 1 ||
            rgbReuse.getByteCount() != 2 || rgbReuse.getAllocationByteCount() != 32 || rgbReuse.getPixel(0, 0) != expected[0])
            throw new AssertionError("BitmapFactory did not reuse a format-matched RGB_565 allocation");

        var densityOptions = new BitmapFactory.Options(); densityOptions.inDensity = 160; densityOptions.inTargetDensity = 320;
        Bitmap densityScaled = BitmapFactory.decodeByteArray(png, 0, png.length, densityOptions);
        if (densityScaled == null || densityScaled.getWidth() != 4 || densityScaled.getHeight() != 4 || densityScaled.getDensity() != 320 || densityScaled.getScaledWidth(320) != 4 || densityScaled.getPixel(0, 0) != expected[0] || densityScaled.getPixel(3, 3) != expected[3])
            throw new AssertionError("BitmapFactory density scaling or output density failed: " + (densityScaled == null ? "null" : densityScaled.getWidth() + "x" + densityScaled.getHeight() + ",density=" + densityScaled.getDensity() + ",scaled=" + densityScaled.getScaledWidth(320) + "x" + densityScaled.getScaledHeight(320) + ",pixels=0x" + Integer.toHexString(densityScaled.getPixel(0, 0)) + "/0x" + Integer.toHexString(densityScaled.getPixel(3, 3))));
        var screenDensityOptions = new BitmapFactory.Options(); screenDensityOptions.inDensity = 160; screenDensityOptions.inTargetDensity = 320; screenDensityOptions.inScreenDensity = 160;
        Bitmap screenDensity = BitmapFactory.decodeByteArray(png, 0, png.length, screenDensityOptions);
        if (screenDensity.getWidth() != 2 || screenDensity.getHeight() != 2 || screenDensity.getDensity() != 160) throw new AssertionError("inScreenDensity did not suppress compatibility scaling");
        var unscaledOptions = new BitmapFactory.Options(); unscaledOptions.inDensity = 160; unscaledOptions.inTargetDensity = 320; unscaledOptions.inScaled = false;
        Bitmap unscaled = BitmapFactory.decodeStream(new ByteArrayInputStream(png), null, unscaledOptions);
        if (unscaled.getWidth() != 2 || unscaled.getHeight() != 2 || unscaled.getDensity() != 160) throw new AssertionError("inScaled=false was ignored");
        Bitmap reuse = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888);
        var reuseOptions = new BitmapFactory.Options(); reuseOptions.inBitmap = reuse; reuseOptions.inSampleSize = 2;
        if (BitmapFactory.decodeByteArray(png, 0, png.length, reuseOptions) != reuse || reuse.getWidth() != 1 || reuse.getHeight() != 1 || reuse.getPixel(0, 0) != expected[0] || reuse.getAllocationByteCount() != 64)
            throw new AssertionError("BitmapFactory did not reuse and reconfigure a larger mutable inBitmap");
        reuseOptions.inSampleSize = 1;
        if (BitmapFactory.decodeByteArray(png, 0, png.length, reuseOptions) != reuse || reuse.getWidth() != 2 || reuse.getHeight() != 2 || reuse.getPixel(1, 1) != expected[3])
            throw new AssertionError("BitmapFactory could not reuse inBitmap after shrinking its active dimensions");
        reuseOptions.inDensity = 160; reuseOptions.inTargetDensity = 320;
        if (BitmapFactory.decodeByteArray(png, 0, png.length, reuseOptions) != reuse || reuse.getWidth() != 4 || reuse.getHeight() != 4 || reuse.getDensity() != 320 || reuse.getPixel(3, 3) != expected[3])
            throw new AssertionError("BitmapFactory could not reuse allocation for density-scaled output");
        var smallReuseOptions = new BitmapFactory.Options(); smallReuseOptions.inBitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        try { BitmapFactory.decodeByteArray(png, 0, png.length, smallReuseOptions); throw new AssertionError("Undersized inBitmap accepted"); }
        catch (IllegalArgumentException expectedError) { smallReuseOptions.inBitmap.recycle(); }
        var immutableReuseOptions = new BitmapFactory.Options(); immutableReuseOptions.inBitmap = decoded;
        try { BitmapFactory.decodeByteArray(png, 0, png.length, immutableReuseOptions); throw new AssertionError("Immutable inBitmap accepted"); }
        catch (IllegalArgumentException expectedError) {}
        Bitmap densityCanvasPixels = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888);
        Canvas densityCanvas = new Canvas(densityCanvasPixels); densityCanvas.setDensity(320);
        Bitmap densitySource = BitmapFactory.decodeByteArray(png, 0, png.length, densityOptions);
        // The decode already scaled to target density; use a source-density bitmap to test Canvas's point overload.
        densitySource.recycle();
        var sourceDensityOptions = new BitmapFactory.Options(); sourceDensityOptions.inDensity = 160;
        densitySource = BitmapFactory.decodeByteArray(png, 0, png.length, sourceDensityOptions);
        densityCanvas.drawBitmap(densitySource, 0, 0, null);
        if (densityCanvasPixels.getPixel(0, 0) != expected[0] || densityCanvasPixels.getPixel(3, 3) != expected[3]) throw new AssertionError("Canvas point draw ignored bitmap density scaling");
        int[] reversed = new int[6]; Arrays.fill(reversed, 7);
        decoded.getPixels(reversed, 3, -2, 0, 0, 2, 2);
        if (reversed[0] != 7 || reversed[5] != 7 || reversed[1] != expected[2] || reversed[2] != expected[3] || reversed[3] != expected[0] || reversed[4] != expected[1]) throw new AssertionError("Negative pixel stride or guards failed");
        Bitmap mutable = decoded.copy(Bitmap.Config.ARGB_8888, true);
        mutable.setPixel(0, 0, 0xff123456);
        if (decoded.getPixel(0, 0) != expected[0] || mutable.getPixel(0, 0) != 0xff123456) throw new AssertionError("Bitmap copy shares storage");
        mutable.setPixels(expected, 0, 2, 0, 0, 2, 2);
        Bitmap tiles = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(tiles);
        canvas.drawBitmap(decoded, new Rect(0, 0, 2, 1), new Rect(0, 1, 2, 2), null);
        canvas.drawBitmap(decoded, new Rect(0, 1, 2, 2), new Rect(0, 0, 2, 1), null);
        int[] tiled = new int[4]; tiles.getPixels(tiled, 0, 2, 0, 0, 2, 2);
        if (!Arrays.equals(tiled, new int[]{expected[2], expected[3], expected[0], expected[1]})) throw new AssertionError("Canvas rectangle tile transform failed");
        canvas.drawBitmap(tiles, new Rect(0, 0, 1, 2), new Rect(1, 0, 2, 2), null);
        if (tiles.getPixel(1, 0) != expected[2] || tiles.getPixel(1, 1) != expected[0]) throw new AssertionError("Canvas overlapping self-copy failed");
        canvas.drawBitmap(decoded, new Rect(0, 0, 2, 2), new Rect(-1, -1, 1, 1), null);
        if (tiles.getPixel(0, 0) != expected[3]) throw new AssertionError("Canvas destination clipping failed");
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        if (!paint.isAntiAlias() || !paint.isFilterBitmap()) throw new AssertionError("Paint flags were not retained");
        paint.setAlpha(128);
        Bitmap scaled = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888);
        new Canvas(scaled).drawBitmap(decoded, new Rect(0, 0, 2, 2), new RectF(0, 0, 4, 4), paint);
        int blended = scaled.getPixel(1, 1);
        if ((blended >>> 24) < 120 || (blended >>> 24) > 136 || ((blended >>> 16) & 255) <= ((blended >>> 8) & 255) || ((blended >>> 8) & 255) == 0 || (blended & 255) == 0)
            throw new AssertionError("Paint alpha or filtered Canvas scaling failed: 0x" + Integer.toHexString(blended));
        scaled.recycle();
        tiles.recycle();
        var output = new ByteArrayOutputStream();
        if (!mutable.compress(Bitmap.CompressFormat.PNG, 100, output)) throw new AssertionError("PNG compression failed");
        Bitmap roundTrip = BitmapFactory.decodeStream(new ByteArrayInputStream(output.toByteArray()));
        if (roundTrip == null) throw new AssertionError("Compressed PNG is undecodable");
        roundTrip.getPixels(actual, 0, 2, 0, 0, 2, 2);
        if (!Arrays.equals(actual, expected)) throw new AssertionError("PNG compression changed opaque pixels");
        var jpeg = new ByteArrayOutputStream();
        if (!mutable.compress(Bitmap.CompressFormat.JPEG, 90, jpeg) || jpeg.toByteArray()[0] != (byte)255 || jpeg.toByteArray()[1] != (byte)216) throw new AssertionError("JPEG encoder did not return JPEG");
        Bitmap jpegDecoded = BitmapFactory.decodeByteArray(jpeg.toByteArray(), 0, jpeg.size());
        if (jpegDecoded == null || jpegDecoded.getWidth() != 2 || jpegDecoded.getHeight() != 2) throw new AssertionError("JPEG round trip dimensions failed");
        var webp = new ByteArrayOutputStream();
        if (!mutable.compress(Bitmap.CompressFormat.WEBP, 80, webp)) throw new AssertionError("WebP compression failed");
        byte[] webpBytes = webp.toByteArray();
        if (webpBytes.length < 12 || webpBytes[0] != 'R' || webpBytes[1] != 'I' || webpBytes[8] != 'W' || webpBytes[9] != 'E' || webpBytes[10] != 'B' || webpBytes[11] != 'P') throw new AssertionError("WebP encoder did not return WebP");
        Bitmap webpDecoded = BitmapFactory.decodeByteArray(webpBytes, 0, webpBytes.length);
        if (webpDecoded == null || webpDecoded.getWidth() != 2 || webpDecoded.getHeight() != 2) throw new AssertionError("WebP round trip dimensions failed");
        if (BitmapFactory.decodeByteArray(new byte[]{1, 2, 3}, 0, 3) != null) throw new AssertionError("Invalid image did not return null");
        try { decoded.setPixel(0, 0, 0); throw new AssertionError("Immutable bitmap was mutated"); } catch (IllegalStateException expectedError) {}
        try { mutable.getPixels(new int[1], 0, 2, 0, 0, 2, 2); throw new AssertionError("Short pixel window accepted"); } catch (ArrayIndexOutOfBoundsException expectedError) {}
        decoded.recycle();
        if (!decoded.isRecycled()) throw new AssertionError("Recycle failed");
        try { decoded.getPixel(0, 0); throw new AssertionError("Recycled pixels accessible"); } catch (IllegalStateException expectedError) {}
        mutable.recycle(); roundTrip.recycle(); jpegDecoded.recycle(); webpDecoded.recycle();
        densityScaled.recycle(); screenDensity.recycle(); unscaled.recycle(); reuse.recycle(); densityCanvasPixels.recycle(); densitySource.recycle();
        rgb565.recycle(); rgb565Mutable.recycle(); alpha8.recycle(); alpha8Mutable.recycle(); argb4444.recycle(); widenedCopy.recycle();
        rgbDecoded.recycle(); alphaDecoded.recycle(); rgbReuse.recycle();
        verifyCanvasTransforms();
        verifyCanvasClips();
        return "Android bitmap bridge: ARGB_8888/RGB_565/ALPHA_8/ARGB_4444 storage, quantization and decode configs, unpremultiplied metadata, bounds/offsets, inSampleSize/inBitmap, density, affine/projective Matrix transforms, Canvas clipping, bitmap and primitive drawing, copy/stride/tiling, PNG/JPEG/WebP codecs, and recycle verified";
    }

    private static void verifyCanvasTransforms() {
        Matrix matrix = new Matrix();
        matrix.setScale(2.0f, 3.0f);
        matrix.postTranslate(4.0f, 5.0f);
        float[] point = {1.0f, 1.0f}; matrix.mapPoints(point);
        if (point[0] != 6.0f || point[1] != 8.0f || matrix.isIdentity()) throw new AssertionError("Matrix post-concat or point mapping failed");
        Matrix inverse = new Matrix();
        if (!matrix.invert(inverse)) throw new AssertionError("Invertible affine matrix was rejected");
        inverse.mapPoints(point);
        if (Math.abs(point[0] - 1.0f) > 0.0001f || Math.abs(point[1] - 1.0f) > 0.0001f) throw new AssertionError("Matrix inverse did not recover the original point");
        RectF mapped = new RectF(0, 0, 2, 1);
        Matrix rotation = new Matrix(); rotation.setRotate(90.0f, 1.0f, 1.0f);
        if (!rotation.mapRect(mapped) || Math.abs(mapped.left - 1.0f) > 0.0001f || Math.abs(mapped.top) > 0.0001f ||
            Math.abs(mapped.right - 2.0f) > 0.0001f || Math.abs(mapped.bottom - 2.0f) > 0.0001f)
            throw new AssertionError("Matrix rotated rectangle bounds are incorrect");

        Bitmap source = Bitmap.createBitmap(new int[]{0xffff0000, 0xff00ff00}, 2, 1, Bitmap.Config.ARGB_8888);
        Bitmap scaledPixels = Bitmap.createBitmap(4, 2, Bitmap.Config.ARGB_8888);
        Canvas scaledCanvas = new Canvas(scaledPixels);
        int saved = scaledCanvas.save();
        scaledCanvas.scale(2.0f, 2.0f);
        scaledCanvas.drawBitmap(source, 0, 0, null);
        if (scaledPixels.getPixel(0, 0) != 0xffff0000 || scaledPixels.getPixel(1, 0) != 0xffff0000 ||
            scaledPixels.getPixel(2, 0) != 0xff00ff00 || scaledPixels.getPixel(3, 0) != 0xff00ff00 ||
            scaledPixels.getPixel(0, 1) != 0xffff0000) throw new AssertionError("Canvas scale did not map bitmap pixels");
        scaledCanvas.restoreToCount(saved);
        Matrix current = new Matrix(); scaledCanvas.getMatrix(current);
        if (!current.isIdentity()) throw new AssertionError("Canvas save/restore did not restore its matrix");
        scaledCanvas.translate(2.0f, 0.0f);
        scaledCanvas.drawBitmap(source, 0, 0, null);
        if (scaledPixels.getPixel(2, 0) != 0xffff0000 || scaledPixels.getPixel(3, 0) != 0xff00ff00)
            throw new AssertionError("Canvas translation changed after restore");

        Bitmap rotatedPixels = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        Canvas rotatedCanvas = new Canvas(rotatedPixels);
        rotatedCanvas.rotate(90.0f, 1.0f, 1.0f);
        rotatedCanvas.drawBitmap(source, 0, 0, null);
        if (rotatedPixels.getPixel(1, 0) != 0xffff0000 || rotatedPixels.getPixel(1, 1) != 0xff00ff00)
            throw new AssertionError("Canvas rotation did not preserve transformed pixel order");

        Matrix singular = new Matrix(); singular.setScale(0.0f, 1.0f);
        if (singular.invert(new Matrix())) throw new AssertionError("Singular affine matrix was reported invertible");

        Matrix perspective = new Matrix();
        perspective.setValues(new float[]{1, 0, 0, 0, 1, 0, 0.25f, 0, 1});
        float[] projected = {2.0f, 0.0f}; perspective.mapPoints(projected);
        if (Math.abs(projected[0] - (4.0f / 3.0f)) > 0.0001f || projected[1] != 0.0f || perspective.rectStaysRect())
            throw new AssertionError("Matrix perspective point mapping failed");
        Matrix perspectiveInverse = new Matrix();
        if (!perspective.invert(perspectiveInverse)) throw new AssertionError("Invertible projective matrix was rejected");
        perspectiveInverse.mapPoints(projected);
        if (Math.abs(projected[0] - 2.0f) > 0.0001f || Math.abs(projected[1]) > 0.0001f)
            throw new AssertionError("Projective matrix inverse did not recover the original point");

        Bitmap perspectivePixels = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888);
        Canvas perspectiveCanvas = new Canvas(perspectivePixels);
        perspectiveCanvas.setMatrix(perspective);
        perspectiveCanvas.drawBitmap(source, 0, 0, null);
        if (perspectivePixels.getPixel(0, 0) != 0xffff0000 || perspectivePixels.getPixel(1, 0) != 0)
            throw new AssertionError("Canvas projective inverse sampling or clipping failed");

        Matrix horizon = new Matrix(); horizon.setValues(new float[]{1, 0, 0, 0, 1, 0, 1, 0, -1});
        Bitmap horizonPixels = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888);
        Canvas horizonCanvas = new Canvas(horizonPixels); horizonCanvas.setMatrix(horizon); horizonCanvas.drawBitmap(source, 0, 0, null);
        if (horizonPixels.getPixel(0, 0) != 0 || horizonPixels.getPixel(1, 0) != 0)
            throw new AssertionError("Canvas drew across a projective horizon");

        Bitmap shapes = Bitmap.createBitmap(8, 6, Bitmap.Config.ARGB_8888);
        Canvas shapeCanvas = new Canvas(shapes);
        Paint redFill = new Paint(); redFill.setColor(0xffff0000);
        shapeCanvas.drawRect(1.0f, 1.0f, 4.0f, 4.0f, redFill);
        if (shapes.getPixel(2, 2) != 0xffff0000 || shapes.getPixel(0, 0) != 0)
            throw new AssertionError("Canvas filled rectangle bounds are incorrect");
        Paint ovalPaint = new Paint(); ovalPaint.setColor(0xff00ff00);
        shapeCanvas.drawOval(new RectF(5.0f, 0.0f, 8.0f, 2.0f), ovalPaint);
        if (shapes.getPixel(6, 1) != 0xff00ff00 || shapes.getPixel(4, 0) != 0)
            throw new AssertionError("Canvas oval bounds are incorrect");
        Paint blueStroke = new Paint(); blueStroke.setColor(0xff0000ff); blueStroke.setStyle(Paint.Style.STROKE); blueStroke.setStrokeWidth(1.0f);
        shapeCanvas.drawRect(new RectF(5.0f, 1.0f, 8.0f, 4.0f), blueStroke);
        if (shapes.getPixel(5, 2) != 0xff0000ff || shapes.getPixel(6, 2) != 0 || shapes.getPixel(7, 2) != 0xff0000ff)
            throw new AssertionError("Canvas stroked rectangle interior or border is incorrect");
        Paint green = new Paint(); green.setColor(0xff00ff00);
        shapeCanvas.drawCircle(2.0f, 4.0f, 0.75f, green);
        if (shapes.getPixel(2, 4) != 0xff00ff00 || shapes.getPixel(4, 4) != 0)
            throw new AssertionError("Canvas filled circle bounds are incorrect");
        Paint line = new Paint(); line.setColor(0xffffff00); line.setStrokeWidth(1.0f); line.setStrokeCap(Paint.Cap.ROUND);
        shapeCanvas.drawLine(0.5f, 4.75f, 6.5f, 4.75f, line);
        if (shapes.getPixel(0, 4) != 0xffffff00 || shapes.getPixel(6, 4) != 0xffffff00)
            throw new AssertionError("Canvas line or round caps were not rasterized");
        Paint points = new Paint(); points.setColor(0xffff00ff); points.setStrokeWidth(1.0f); points.setStrokeCap(Paint.Cap.ROUND);
        shapeCanvas.drawPoint(7.25f, 4.75f, points);
        points.setColor(0xff00ffff);
        shapeCanvas.drawPoints(new float[]{0.5f, 0.5f}, 0, 2, points);
        if (shapes.getPixel(7, 4) != 0xffff00ff || shapes.getPixel(0, 0) != 0xff00ffff)
            throw new AssertionError("Canvas point rasterization or point windows are incorrect");

        source.recycle(); scaledPixels.recycle(); rotatedPixels.recycle(); perspectivePixels.recycle(); horizonPixels.recycle(); shapes.recycle();
    }

    private static void verifyCanvasClips() {
        Bitmap pixels = Bitmap.createBitmap(6, 4, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(pixels);
        if (!canvas.clipRect(new RectF(1.0f, 1.0f, 5.0f, 3.0f))) throw new AssertionError("Canvas intersection clip was reported empty");
        canvas.drawColor(0xffff0000);
        if (pixels.getPixel(1, 1) != 0xffff0000 || pixels.getPixel(4, 2) != 0xffff0000 || pixels.getPixel(0, 1) != 0 || pixels.getPixel(5, 2) != 0)
            throw new AssertionError("Canvas color draw ignored its rectangular clip");
        int saved = canvas.save();
        if (!canvas.clipOutRect(2.0f, 1.0f, 4.0f, 3.0f)) throw new AssertionError("Canvas difference clip erased the remaining region");
        canvas.drawColor(0xff0000ff);
        if (pixels.getPixel(1, 1) != 0xff0000ff || pixels.getPixel(4, 1) != 0xff0000ff ||
            pixels.getPixel(2, 1) != 0xffff0000 || pixels.getPixel(3, 2) != 0xffff0000)
            throw new AssertionError("Canvas difference clip did not exclude only its rectangle");
        canvas.restoreToCount(saved);
        Paint green = new Paint(); green.setColor(0xff00ff00);
        canvas.drawRect(2.0f, 1.0f, 4.0f, 2.0f, green);
        if (pixels.getPixel(2, 1) != 0xff00ff00 || pixels.getPixel(0, 0) != 0)
            throw new AssertionError("Canvas restore did not reinstate the prior clip");

        Bitmap transformedPixels = Bitmap.createBitmap(6, 5, Bitmap.Config.ARGB_8888);
        Canvas transformed = new Canvas(transformedPixels);
        transformed.translate(2.0f, 1.0f);
        if (!transformed.clipRect(0.0f, 0.0f, 2.0f, 2.0f)) throw new AssertionError("Transformed clip was reported empty");
        transformed.setMatrix(null);
        transformed.drawColor(0xffffff00);
        if (transformedPixels.getPixel(2, 1) != 0xffffff00 || transformedPixels.getPixel(3, 2) != 0xffffff00 || transformedPixels.getPixel(1, 1) != 0)
            throw new AssertionError("Canvas clip moved when the transform changed after clipping");
        if (transformed.clipRect(10.0f, 10.0f, 11.0f, 11.0f)) throw new AssertionError("Off-bitmap clip was reported non-empty");
        transformed.drawColor(0xffffffff);
        if (transformedPixels.getPixel(2, 1) != 0xffffff00) throw new AssertionError("Empty clip allowed drawing");
        pixels.recycle(); transformedPixels.recycle();
    }
}
