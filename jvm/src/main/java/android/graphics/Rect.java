package android.graphics;

/** Integer rectangle API used by source image-tile transforms. */
public final class Rect {
    public int left, top, right, bottom;
    public Rect() {}
    public Rect(int left, int top, int right, int bottom) { set(left, top, right, bottom); }
    public Rect(Rect other) { if (other != null) set(other); }
    public void set(int left, int top, int right, int bottom) { this.left = left; this.top = top; this.right = right; this.bottom = bottom; }
    public void set(Rect other) { set(other.left, other.top, other.right, other.bottom); }
    public int width() { return right - left; }
    public int height() { return bottom - top; }
    public boolean isEmpty() { return left >= right || top >= bottom; }
    public boolean contains(int x, int y) { return x >= left && x < right && y >= top && y < bottom; }
    public void offset(int dx, int dy) { left += dx; right += dx; top += dy; bottom += dy; }
}
