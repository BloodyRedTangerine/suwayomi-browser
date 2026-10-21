package android.graphics;

/** Float rectangle overload used by common Canvas bitmap calls. */
public final class RectF {
    public float left, top, right, bottom;
    public RectF() {}
    public RectF(float left, float top, float right, float bottom) { set(left, top, right, bottom); }
    public RectF(RectF other) { if (other != null) set(other); }
    public RectF(Rect other) { if (other != null) set(other); }
    public void set(float left, float top, float right, float bottom) { this.left = left; this.top = top; this.right = right; this.bottom = bottom; }
    public void set(RectF other) { set(other.left, other.top, other.right, other.bottom); }
    public void set(Rect other) { set(other.left, other.top, other.right, other.bottom); }
    public float width() { return right - left; }
    public float height() { return bottom - top; }
    public boolean isEmpty() { return left >= right || top >= bottom; }
    public void offset(float dx, float dy) { left += dx; right += dx; top += dy; bottom += dy; }
}
