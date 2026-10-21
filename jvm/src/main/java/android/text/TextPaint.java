package android.text;

import android.graphics.Paint;

/** Paint state used by StaticLayout and browser Canvas text rasterization. */
public class TextPaint extends Paint {
    public float density = 1.0f;
    public int baselineShift;
    public int linkColor;
    public TextPaint() { super(); }
    public TextPaint(int flags) { super(flags); }
    public TextPaint(Paint other) { super(other); }
}
