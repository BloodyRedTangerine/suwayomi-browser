package android.text;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import java.util.Objects;

/** Text layout surface backed by browser-native font metrics and pixels. */
public abstract class Layout {
    public enum Alignment { ALIGN_NORMAL, ALIGN_OPPOSITE, ALIGN_CENTER, ALIGN_LEFT, ALIGN_RIGHT }
    public static final int BREAK_STRATEGY_SIMPLE = 0;
    public static final int BREAK_STRATEGY_HIGH_QUALITY = 1;
    public static final int BREAK_STRATEGY_BALANCED = 2;
    public static final int HYPHENATION_FREQUENCY_NONE = 0;
    public static final int HYPHENATION_FREQUENCY_NORMAL = 1;
    public static final int HYPHENATION_FREQUENCY_FULL = 2;
    public static final int HYPHENATION_FREQUENCY_NORMAL_FAST = 3;
    public static final int HYPHENATION_FREQUENCY_FULL_FAST = 4;
    private final CharSequence text;
    private final TextPaint paint;
    private final int width;
    private final Alignment alignment;
    private final Bitmap raster;
    private final int lineCount;
    private final int height;
    private final int[] lineEnds;
    private final float[] lineWidths;
    private final int breakStrategy;
    private final int hyphenationFrequency;

    protected Layout(CharSequence text, TextPaint paint, int width, Alignment alignment,
                     float spacingMultiplier, float spacingExtra, boolean includePad) {
        this(text, paint, width, alignment, spacingMultiplier, spacingExtra, includePad,
            BREAK_STRATEGY_SIMPLE, HYPHENATION_FREQUENCY_NONE);
    }

    protected Layout(CharSequence text, TextPaint paint, int width, Alignment alignment,
                     float spacingMultiplier, float spacingExtra, boolean includePad,
                     int breakStrategy, int hyphenationFrequency) {
        this.text = text == null ? "" : text;
        this.paint = paint == null ? new TextPaint() : new TextPaint(paint);
        if (width <= 0) throw new IllegalArgumentException("Layout width must be positive");
        this.width = width;
        this.alignment = alignment == null ? Alignment.ALIGN_NORMAL : alignment;
        this.breakStrategy = breakStrategy;
        this.hyphenationFrequency = hyphenationFrequency;
        var result = suwayomi.browser.TextRasterizer.layout(this.text.toString(), width, this.paint,
            this.alignment.ordinal(), breakStrategy, hyphenationFrequency,
            spacingMultiplier, spacingExtra, includePad);
        this.lineCount = result.lines();
        this.height = result.height();
        this.lineEnds = result.lineEnds();
        this.lineWidths = result.lineWidths();
        this.raster = Bitmap.createBitmap(result.pixels(), result.width(), result.height(), Bitmap.Config.ARGB_8888);
    }
    public abstract int getHeight();
    public CharSequence getText() { return text; }
    public TextPaint getPaint() { return new TextPaint(paint); }
    public int getWidth() { return width; }
    public Alignment getAlignment() { return alignment; }
    public final int getBreakStrategy() { return breakStrategy; }
    public final int getHyphenationFrequency() { return hyphenationFrequency; }
    public int getLineCount() { return lineCount; }
    public int getLineStart(int line) {
        checkLine(line);
        return line == 0 ? 0 : lineEnds[line - 1];
    }
    public int getLineEnd(int line) {
        checkLine(line);
        return lineEnds[line];
    }
    public float getLineWidth(int line) {
        checkLine(line);
        return lineWidths[line];
    }
    protected int getRasterHeight() { return height; }
    public void draw(Canvas canvas) { Objects.requireNonNull(canvas).drawBitmap(raster, 0, 0, (Paint)null); }

    private void checkLine(int line) {
        if (line < 0 || line >= lineCount) throw new IndexOutOfBoundsException("Line index out of range: " + line);
    }
}
