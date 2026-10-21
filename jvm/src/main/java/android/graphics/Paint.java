package android.graphics;

/**
 * State used by the bitmap subset of Android's Paint API.
 *
 * Source extensions commonly pass a Paint even when they only need bitmap
 * filtering or opacity. Keeping that state here lets Canvas implement those
 * operations without pretending that text, shaders or GPU effects exist in
 * the browser worker.
 */
public class Paint {
    public static final int FILTER_BITMAP_FLAG = 0x40;
    public static final int DITHER_FLAG = 0x04;
    public static final int ANTI_ALIAS_FLAG = 0x02;
    public static final int SUBPIXEL_TEXT_FLAG = 0x80;
    public static final int LINEAR_TEXT_FLAG = 0x40;
    public static final int STRIKE_THRU_TEXT_FLAG = 0x10;
    public static final int UNDERLINE_TEXT_FLAG = 0x08;
    public static final int FAKE_BOLD_TEXT_FLAG = 0x20;

    public enum Style { FILL, STROKE, FILL_AND_STROKE }
    public enum Cap { BUTT, ROUND, SQUARE }
    public enum Join { MITER, ROUND, BEVEL }

    private int flags;
    private int color = 0xff000000;
    private int alpha = 255;
    private float strokeWidth;
    private Style style = Style.FILL;
    private Cap strokeCap = Cap.BUTT;
    private Join strokeJoin = Join.MITER;
    private float strokeMiter = 4.0f;
    private float textSize = 16.0f;
    private float textScaleX = 1.0f;
    private float textSkewX;
    private Typeface typeface;

    public Paint() {}
    public Paint(int flags) { this.flags = flags; }
    public Paint(Paint other) { set(other); }

    public void reset() {
        flags = 0; color = 0xff000000; alpha = 255; strokeWidth = 0.0f;
        style = Style.FILL; strokeCap = Cap.BUTT; strokeJoin = Join.MITER;
        strokeMiter = 4.0f; textSize = 16.0f; textScaleX = 1.0f; textSkewX = 0.0f; typeface = null;
    }
    public void set(Paint other) {
        if (other == null) { reset(); return; }
        flags = other.flags; color = other.color; alpha = other.alpha;
        strokeWidth = other.strokeWidth; style = other.style;
        strokeCap = other.strokeCap; strokeJoin = other.strokeJoin;
        strokeMiter = other.strokeMiter; textSize = other.textSize;
        textScaleX = other.textScaleX; textSkewX = other.textSkewX;
        typeface = other.typeface;
    }

    public int getFlags() { return flags; }
    public void setFlags(int flags) { this.flags = flags; }
    public void setAntiAlias(boolean enabled) { setFlag(ANTI_ALIAS_FLAG, enabled); }
    public boolean isAntiAlias() { return hasFlag(ANTI_ALIAS_FLAG); }
    public void setDither(boolean enabled) { setFlag(DITHER_FLAG, enabled); }
    public boolean isDither() { return hasFlag(DITHER_FLAG); }
    public void setFilterBitmap(boolean enabled) { setFlag(FILTER_BITMAP_FLAG, enabled); }
    public boolean isFilterBitmap() { return hasFlag(FILTER_BITMAP_FLAG); }
    public void setSubpixelText(boolean enabled) { setFlag(SUBPIXEL_TEXT_FLAG, enabled); }
    public boolean isSubpixelText() { return hasFlag(SUBPIXEL_TEXT_FLAG); }
    private boolean hasFlag(int flag) { return (flags & flag) != 0; }
    private void setFlag(int flag, boolean enabled) { flags = enabled ? flags | flag : flags & ~flag; }

    public int getColor() { return color; }
    public void setColor(int color) { this.color = color; this.alpha = color >>> 24; }
    public int getAlpha() { return alpha; }
    public void setAlpha(int alpha) {
        this.alpha = Math.max(0, Math.min(255, alpha));
        color = (color & 0x00ffffff) | (this.alpha << 24);
    }
    public void setARGB(int alpha, int red, int green, int blue) {
        this.alpha = clamp(alpha); color = (this.alpha << 24) | (clamp(red) << 16) | (clamp(green) << 8) | clamp(blue);
    }
    private static int clamp(int value) { return Math.max(0, Math.min(255, value)); }

    public Style getStyle() { return style; }
    public void setStyle(Style style) { this.style = style == null ? Style.FILL : style; }
    public float getStrokeWidth() { return strokeWidth; }
    public void setStrokeWidth(float width) { strokeWidth = Math.max(0.0f, width); }
    public Cap getStrokeCap() { return strokeCap; }
    public void setStrokeCap(Cap cap) { strokeCap = cap == null ? Cap.BUTT : cap; }
    public Join getStrokeJoin() { return strokeJoin; }
    public void setStrokeJoin(Join join) { strokeJoin = join == null ? Join.MITER : join; }
    public float getStrokeMiter() { return strokeMiter; }
    public void setStrokeMiter(float miter) { strokeMiter = Math.max(0.0f, miter); }

    public float getTextSize() { return textSize; }
    public void setTextSize(float size) { textSize = Math.max(0.0f, size); }
    public float getTextScaleX() { return textScaleX; }
    public void setTextScaleX(float scale) { textScaleX = scale; }
    public float getTextSkewX() { return textSkewX; }
    public void setTextSkewX(float skew) { textSkewX = skew; }
    public Typeface setTypeface(Typeface typeface) { Typeface previous = this.typeface; this.typeface = typeface; return previous; }
    public Typeface getTypeface() { return typeface; }
    public void setFakeBoldText(boolean enabled) { setFlag(FAKE_BOLD_TEXT_FLAG, enabled); }
    public boolean isFakeBoldText() { return hasFlag(FAKE_BOLD_TEXT_FLAG); }
    public void setUnderlineText(boolean enabled) { setFlag(UNDERLINE_TEXT_FLAG, enabled); }
    public boolean isUnderlineText() { return hasFlag(UNDERLINE_TEXT_FLAG); }
    public void setStrikeThruText(boolean enabled) { setFlag(STRIKE_THRU_TEXT_FLAG, enabled); }
    public boolean isStrikeThruText() { return hasFlag(STRIKE_THRU_TEXT_FLAG); }

    /** Effective source alpha for Canvas bitmap compositing. */
    int effectiveAlpha(int sourceAlpha) { return sourceAlpha * alpha / 255; }
}
