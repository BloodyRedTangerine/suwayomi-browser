package suwayomi.browser;

import android.graphics.Bitmap;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.TextPaint;
import java.io.IOException;
import java.util.Base64;
import java.util.BitSet;
import java.util.Locale;
import java.text.StringCharacterIterator;
import com.ibm.icu.text.BreakIterator;
import org.json.JSONArray;
import org.json.JSONObject;

/** Synchronous request/reply to the local worker's OffscreenCanvas text implementation. */
public final class TextRasterizer {
    public record Result(int width, int height, int lines, int[] pixels, int[] lineEnds, float[] lineWidths) {}
    private TextRasterizer() {}

    public static Result layout(String text, int width, TextPaint paint, int alignment,
                                int breakStrategy, int hyphenationFrequency,
                                float spacingMultiplier, float spacingExtra, boolean includePad) {
        if (text.length() > 1_000_000) throw new IllegalArgumentException("Text layout input exceeds one million characters");
        Typeface face = paint.getTypeface() == null ? Typeface.DEFAULT : paint.getTypeface();
        JSONObject request = new JSONObject()
            .put("action", "layoutText").put("text", text).put("width", width)
            .put("color", paint.getColor()).put("textSize", paint.getTextSize())
            .put("family", face.getFamily()).put("style", face.getStyle())
            .put("fakeBold", paint.isFakeBoldText()).put("underline", paint.isUnderlineText())
            .put("strike", paint.isStrikeThruText()).put("textScaleX", paint.getTextScaleX())
            .put("textSkewX", paint.getTextSkewX()).put("alignment", alignment)
            .put("breakStrategy", breakStrategy).put("hyphenationFrequency", hyphenationFrequency)
            .put("lineBreaks", boundaryMap(text, false)).put("graphemeBreaks", boundaryMap(text, true))
            .put("spacingMultiplier", spacingMultiplier).put("spacingExtra", spacingExtra)
            .put("includePad", includePad);
        try {
            JSONObject response = new JSONObject(BrowserTransport.image(request.toString()));
            if (response.has("error")) throw new IllegalStateException(response.getString("error"));
            int imageWidth = response.getInt("width"), imageHeight = response.getInt("height"), lines = response.getInt("lines");
            long count = (long)imageWidth * imageHeight;
            if (imageWidth <= 0 || imageHeight <= 0 || imageWidth > 8192 || imageHeight > 8192 || count > 4 * 1024 * 1024 || lines < 0)
                throw new IOException("Invalid browser text raster dimensions");
            byte[] rgba = Base64.getDecoder().decode(response.getString("body"));
            if (rgba.length != count * 4) throw new IOException("Invalid browser text raster pixel count");
            int[] pixels = new int[(int)count];
            for (int index = 0; index < pixels.length; index++) {
                int offset = index * 4;
                pixels[index] = (rgba[offset + 3] & 255) << 24 | (rgba[offset] & 255) << 16 |
                    (rgba[offset + 1] & 255) << 8 | rgba[offset + 2] & 255;
            }
            JSONArray endsJson = response.getJSONArray("lineEnds");
            JSONArray widthsJson = response.getJSONArray("lineWidths");
            if (endsJson.length() != lines || widthsJson.length() != lines || lines == 0)
                throw new IOException("Invalid browser text line metadata");
            int[] lineEnds = new int[lines];
            float[] lineWidths = new float[lines];
            int previousEnd = 0;
            for (int index = 0; index < lines; index++) {
                int end = endsJson.getInt(index);
                float lineWidth = (float)widthsJson.getDouble(index);
                if (end < previousEnd || end > text.length() || !Float.isFinite(lineWidth) || lineWidth < 0)
                    throw new IOException("Invalid browser text line metadata");
                lineEnds[index] = end;
                lineWidths[index] = lineWidth;
                previousEnd = end;
            }
            if (previousEnd != text.length()) throw new IOException("Browser text line metadata does not cover the source text");
            return new Result(imageWidth, imageHeight, lines, pixels, lineEnds, lineWidths);
        } catch (IOException error) { throw new IllegalStateException("Browser text rasterization failed", error); }
    }

    private static String boundaryMap(String text, boolean graphemes) {
        BreakIterator iterator = graphemes
            ? BreakIterator.getCharacterInstance(Locale.ROOT)
            : BreakIterator.getLineInstance(Locale.ROOT);
        iterator.setText(new StringCharacterIterator(text));
        BitSet boundaries = new BitSet(text.length() + 1);
        for (int boundary = iterator.first(); boundary != BreakIterator.DONE; boundary = iterator.next()) {
            if (boundary >= 0 && boundary <= text.length()) boundaries.set(boundary);
        }
        boundaries.set(0);
        boundaries.set(text.length());
        return Base64.getEncoder().encodeToString(boundaries.toByteArray());
    }
}
