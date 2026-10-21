package android.graphics;

import java.util.Objects;
import java.util.ArrayList;
import java.util.List;

/** A bounded source-over bitmap Canvas implemented over local ARGB pixels. */
public final class Canvas {
    private Bitmap bitmap;
    private int density;
    private final List<CanvasState> states = new ArrayList<>(List.of(new CanvasState()));
    public Canvas() {}
    public Canvas(Bitmap bitmap) { setBitmap(bitmap); }
    public void setBitmap(Bitmap bitmap) {
        if (bitmap != null && (!bitmap.isMutable() || bitmap.isRecycled())) throw new IllegalStateException("Canvas requires a mutable live bitmap");
        this.bitmap = bitmap;
        density = bitmap == null ? 0 : bitmap.getDensity();
    }
    public int getWidth() { return bitmap == null ? 0 : bitmap.getWidth(); }
    public int getHeight() { return bitmap == null ? 0 : bitmap.getHeight(); }
    public int getDensity() { return density; }
    public void setDensity(int density) { this.density = density; }
    public int save() { states.add(new CanvasState(currentState())); return states.size() - 1; }
    public int getSaveCount() { return states.size(); }
    public void restore() {
        if (states.size() <= 1) throw new IllegalStateException("Canvas has no saved state to restore");
        states.remove(states.size() - 1);
    }
    public void restoreToCount(int count) {
        if (count < 1 || count > states.size()) throw new IllegalArgumentException("Invalid Canvas save count");
        while (states.size() > count) restore();
    }
    public void translate(float dx, float dy) {
        currentTransform().preTranslate(dx, dy);
    }
    public void scale(float sx, float sy) { currentTransform().preScale(sx, sy); }
    public void scale(float sx, float sy, float px, float py) { currentTransform().preScale(sx, sy, px, py); }
    public void rotate(float degrees) { currentTransform().preRotate(degrees); }
    public void rotate(float degrees, float px, float py) { currentTransform().preRotate(degrees, px, py); }
    public void skew(float sx, float sy) { currentTransform().preSkew(sx, sy); }
    public void concat(Matrix matrix) { currentTransform().preConcat(matrix); }
    public void setMatrix(Matrix matrix) { currentTransform().set(matrix); }
    public void getMatrix(Matrix matrix) { if (matrix == null) throw new NullPointerException("matrix"); matrix.set(currentTransform()); }
    private CanvasState currentState() { return states.get(states.size() - 1); }
    private Matrix currentTransform() { return currentState().matrix; }

    public boolean clipRect(float left, float top, float right, float bottom) {
        RectF rect = new RectF(left, top, right, bottom);
        float[] polygon = devicePolygon(rect);
        currentState().clips.add(new ClipRegion(polygon, false));
        return hasVisiblePixel();
    }
    public boolean clipRect(Rect rect) {
        Objects.requireNonNull(rect, "rect"); return clipRect(rect.left, rect.top, rect.right, rect.bottom);
    }
    public boolean clipRect(RectF rect) {
        Objects.requireNonNull(rect, "rect"); return clipRect(rect.left, rect.top, rect.right, rect.bottom);
    }
    public boolean clipOutRect(float left, float top, float right, float bottom) {
        RectF rect = new RectF(left, top, right, bottom);
        float[] polygon = devicePolygon(rect);
        if (polygon.length == 0 && left < right && top < bottom) {
            currentState().clips.add(new ClipRegion(new float[0], false));
        } else if (polygon.length != 0) {
            currentState().clips.add(new ClipRegion(polygon, true));
        }
        return hasVisiblePixel();
    }
    public boolean clipOutRect(Rect rect) {
        Objects.requireNonNull(rect, "rect"); return clipOutRect(rect.left, rect.top, rect.right, rect.bottom);
    }
    public boolean clipOutRect(RectF rect) {
        Objects.requireNonNull(rect, "rect"); return clipOutRect(rect.left, rect.top, rect.right, rect.bottom);
    }

    private float[] devicePolygon(RectF rect) {
        checkFinite(rect.left, rect.top, rect.right, rect.bottom);
        if (rect.left >= rect.right || rect.top >= rect.bottom) return new float[0];
        float[] points = {rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom};
        Matrix matrix = currentTransform();
        if (matrix.hasPerspective()) {
            float[] values = new float[9]; matrix.getValues(values);
            float minW = Float.POSITIVE_INFINITY, maxW = Float.NEGATIVE_INFINITY;
            for (int i = 0; i < points.length; i += 2) {
                float w = values[Matrix.MPERSP_0] * points[i] + values[Matrix.MPERSP_1] * points[i + 1] + values[Matrix.MPERSP_2];
                minW = Math.min(minW, w); maxW = Math.max(maxW, w);
            }
            if (minW <= 0.0f && maxW >= 0.0f) return new float[0];
        }
        matrix.mapPoints(points);
        for (float point : points) if (!Float.isFinite(point)) return new float[0];
        return points;
    }

    private boolean hasVisiblePixel() {
        if (bitmap == null || bitmap.isRecycled()) return false;
        int left = 0, top = 0, right = bitmap.getWidth(), bottom = bitmap.getHeight();
        for (ClipRegion region : currentState().clips) if (!region.exclude) {
            if (region.points.length == 0) return false;
            float minX = region.points[0], maxX = minX, minY = region.points[1], maxY = minY;
            for (int i = 2; i < region.points.length; i += 2) {
                minX = Math.min(minX, region.points[i]); maxX = Math.max(maxX, region.points[i]);
                minY = Math.min(minY, region.points[i + 1]); maxY = Math.max(maxY, region.points[i + 1]);
            }
            left = Math.max(left, (int)Math.max(0.0, Math.floor(minX)));
            top = Math.max(top, (int)Math.max(0.0, Math.floor(minY)));
            right = Math.min(right, (int)Math.min(bitmap.getWidth(), Math.ceil(maxX)));
            bottom = Math.min(bottom, (int)Math.min(bitmap.getHeight(), Math.ceil(maxY)));
        }
        if (left >= right || top >= bottom) return false;
        for (int y = top; y < bottom; y++) for (int x = left; x < right; x++) if (isPointVisible(x + 0.5f, y + 0.5f)) return true;
        return false;
    }

    private boolean isPointVisible(float x, float y) {
        for (ClipRegion region : currentState().clips) {
            boolean inside = contains(region.points, x, y);
            if (region.exclude ? inside : !inside) return false;
        }
        return true;
    }

    private static boolean contains(float[] polygon, float x, float y) {
        if (polygon.length < 6) return false;
        float orientation = 0.0f;
        for (int i = 0; i < polygon.length; i += 2) {
            int next = (i + 2) % polygon.length;
            float cross = (polygon[next] - polygon[i]) * (y - polygon[i + 1]) -
                (polygon[next + 1] - polygon[i + 1]) * (x - polygon[i]);
            if (Math.abs(cross) <= 1.0e-5f) continue;
            if (orientation == 0.0f) orientation = Math.signum(cross);
            else if (orientation * cross < 0.0f) return false;
        }
        return orientation != 0.0f;
    }

    public void drawColor(int color) {
        if (bitmap == null || bitmap.isRecycled()) return;
        int alpha = color >>> 24;
        for (int y = 0; y < bitmap.getHeight(); y++) for (int x = 0; x < bitmap.getWidth(); x++) {
            if (!isPointVisible(x + 0.5f, y + 0.5f)) continue;
            if (alpha == 255) bitmap.setPixel(x, y, color);
            else if (alpha != 0) bitmap.setPixel(x, y, over(color, bitmap.getPixel(x, y)));
        }
    }

    public void drawRect(float left, float top, float right, float bottom, Paint paint) {
        Objects.requireNonNull(paint, "paint");
        checkFinite(left, top, right, bottom);
        if (left > right || top > bottom) return;
        Paint.Style style = paint.getStyle();
        float halfStroke = strokeRadius(paint);
        boolean stroked = style != Paint.Style.FILL;
        RectF bounds = new RectF(stroked ? left - halfStroke : left, stroked ? top - halfStroke : top,
            stroked ? right + halfStroke : right, stroked ? bottom + halfStroke : bottom);
        rasterize(bounds, (x, y, localX, localY) -> {
            if (style == Paint.Style.STROKE && localX > left + halfStroke && localX < right - halfStroke &&
                localY > top + halfStroke && localY < bottom - halfStroke) return;
            drawPaintPixel(x, y, paint.getColor(), paint);
        });
    }
    public void drawRect(RectF rect, Paint paint) {
        Objects.requireNonNull(rect, "rect"); drawRect(rect.left, rect.top, rect.right, rect.bottom, paint);
    }
    public void drawRect(Rect rect, Paint paint) {
        Objects.requireNonNull(rect, "rect"); drawRect(rect.left, rect.top, rect.right, rect.bottom, paint);
    }

    public void drawLine(float startX, float startY, float stopX, float stopY, Paint paint) {
        Objects.requireNonNull(paint, "paint"); checkFinite(startX, startY, stopX, stopY);
        float radius = strokeRadius(paint), dx = stopX - startX, dy = stopY - startY;
        float lengthSquared = dx * dx + dy * dy;
        RectF bounds = new RectF(Math.min(startX, stopX) - radius, Math.min(startY, stopY) - radius,
            Math.max(startX, stopX) + radius, Math.max(startY, stopY) + radius);
        rasterize(bounds, (x, y, localX, localY) -> {
            float t = lengthSquared == 0.0f ? 0.0f : ((localX - startX) * dx + (localY - startY) * dy) / lengthSquared;
            Paint.Cap cap = paint.getStrokeCap();
            if (cap == Paint.Cap.BUTT && (t < 0.0f || t > 1.0f)) return;
            if (cap == Paint.Cap.SQUARE && lengthSquared > 0.0f) {
                float extension = radius / (float)Math.sqrt(lengthSquared);
                if (t < -extension || t > 1.0f + extension) return;
            }
            float nearestT = Math.max(0.0f, Math.min(1.0f, t));
            float px = startX + nearestT * dx, py = startY + nearestT * dy;
            float offsetX = localX - px, offsetY = localY - py;
            if (offsetX * offsetX + offsetY * offsetY <= radius * radius) drawPaintPixel(x, y, paint.getColor(), paint);
        });
    }

    public void drawCircle(float cx, float cy, float radius, Paint paint) {
        Objects.requireNonNull(paint, "paint"); checkFinite(cx, cy, radius);
        if (radius < 0.0f) throw new IllegalArgumentException("Circle radius must be non-negative");
        Paint.Style style = paint.getStyle(); float halfStroke = strokeRadius(paint);
        float outer = radius + (style == Paint.Style.FILL ? 0.0f : halfStroke);
        float inner = Math.max(0.0f, radius - halfStroke);
        RectF bounds = new RectF(cx - outer, cy - outer, cx + outer, cy + outer);
        rasterize(bounds, (x, y, localX, localY) -> {
            float dx = localX - cx, dy = localY - cy, distanceSquared = dx * dx + dy * dy;
            if (style == Paint.Style.STROKE && distanceSquared < inner * inner) return;
            if (distanceSquared <= outer * outer) drawPaintPixel(x, y, paint.getColor(), paint);
        });
    }

    public void drawOval(float left, float top, float right, float bottom, Paint paint) {
        Objects.requireNonNull(paint, "paint"); checkFinite(left, top, right, bottom);
        if (left >= right || top >= bottom) return;
        Paint.Style style = paint.getStyle(); float halfStroke = strokeRadius(paint);
        float cx = (left + right) * 0.5f, cy = (top + bottom) * 0.5f;
        float radiusX = (right - left) * 0.5f, radiusY = (bottom - top) * 0.5f;
        float outerX = radiusX + (style == Paint.Style.FILL ? 0.0f : halfStroke);
        float outerY = radiusY + (style == Paint.Style.FILL ? 0.0f : halfStroke);
        float innerX = Math.max(0.0f, radiusX - halfStroke), innerY = Math.max(0.0f, radiusY - halfStroke);
        RectF bounds = new RectF(cx - outerX, cy - outerY, cx + outerX, cy + outerY);
        rasterize(bounds, (x, y, localX, localY) -> {
            float dx = localX - cx, dy = localY - cy;
            float outerMetric = dx * dx / (outerX * outerX) + dy * dy / (outerY * outerY);
            if (outerMetric > 1.0f) return;
            if (style == Paint.Style.STROKE && innerX > 0.0f && innerY > 0.0f &&
                dx * dx / (innerX * innerX) + dy * dy / (innerY * innerY) < 1.0f) return;
            drawPaintPixel(x, y, paint.getColor(), paint);
        });
    }
    public void drawOval(RectF oval, Paint paint) {
        Objects.requireNonNull(oval, "oval"); drawOval(oval.left, oval.top, oval.right, oval.bottom, paint);
    }
    public void drawOval(Rect oval, Paint paint) {
        Objects.requireNonNull(oval, "oval"); drawOval(oval.left, oval.top, oval.right, oval.bottom, paint);
    }

    public void drawPoint(float x, float y, Paint paint) {
        Objects.requireNonNull(paint, "paint"); checkFinite(x, y);
        float radius = strokeRadius(paint);
        if (paint.getStrokeCap() == Paint.Cap.ROUND) {
            Paint.Style style = paint.getStyle(); paint.setStyle(Paint.Style.FILL);
            try { drawCircle(x, y, radius, paint); } finally { paint.setStyle(style); }
        } else {
            Paint.Style style = paint.getStyle(); paint.setStyle(Paint.Style.FILL);
            try { drawRect(x - radius, y - radius, x + radius, y + radius, paint); } finally { paint.setStyle(style); }
        }
    }
    public void drawPoints(float[] points, int offset, int count, Paint paint) {
        Objects.requireNonNull(points, "points"); Objects.requireNonNull(paint, "paint");
        if (offset < 0 || count < 0 || (count & 1) != 0 || (long)offset + count > points.length)
            throw new ArrayIndexOutOfBoundsException("Invalid Canvas point array window");
        for (int i = offset; i < offset + count; i += 2) drawPoint(points[i], points[i + 1], paint);
    }

    public void drawBitmap(Bitmap image, int left, int top, Paint paint) {
        Objects.requireNonNull(image);
        int width = image.getScaledWidth(density), height = image.getScaledHeight(density);
        drawBitmap(image, null, new Rect(left, top, Math.addExact(left, width), Math.addExact(top, height)), paint);
    }

    public void drawBitmap(Bitmap image, float left, float top, Paint paint) {
        if (!Float.isFinite(left) || !Float.isFinite(top)) throw new IllegalArgumentException("Bitmap position must be finite");
        drawBitmap(image, Math.round(left), Math.round(top), paint);
    }

    public void drawBitmap(Bitmap image, Rect src, RectF dst, Paint paint) {
        Objects.requireNonNull(dst);
        if (dst.left < Integer.MIN_VALUE || dst.top < Integer.MIN_VALUE || dst.right > Integer.MAX_VALUE || dst.bottom > Integer.MAX_VALUE)
            throw new IllegalArgumentException("Bitmap destination exceeds integer Canvas bounds");
        drawBitmap(image, src, new Rect(Math.round(dst.left), Math.round(dst.top), Math.round(dst.right), Math.round(dst.bottom)), paint);
    }

    public void drawBitmap(Bitmap image, Rect src, Rect dst, Paint paint) {
        Objects.requireNonNull(image); Objects.requireNonNull(dst);
        if (bitmap == null) return;
        if (image.isRecycled() || bitmap.isRecycled()) throw new IllegalStateException("Canvas cannot draw recycled pixels");
        if (src == null) src = new Rect(0, 0, image.getWidth(), image.getHeight());
        if (src.isEmpty() || dst.isEmpty()) return;
        if (src.left < 0 || src.top < 0 || src.right > image.getWidth() || src.bottom > image.getHeight()) throw new IllegalArgumentException("Source rectangle outside bitmap");
        int sourceWidth = src.width(), sourceHeight = src.height();
        int destinationWidth = dst.width(), destinationHeight = dst.height();
        if (destinationWidth <= 0 || destinationHeight <= 0) return;
        int[] snapshot = new int[Math.multiplyExact(sourceWidth, sourceHeight)];
        image.getPixels(snapshot, 0, sourceWidth, src.left, src.top, sourceWidth, sourceHeight);
        Matrix transform = currentTransform();
        float[] corners = {dst.left, dst.top, dst.right, dst.top, dst.right, dst.bottom, dst.left, dst.bottom};
        if (transform.hasPerspective()) {
            float[] values = new float[9]; transform.getValues(values);
            float minimumW = Float.POSITIVE_INFINITY, maximumW = Float.NEGATIVE_INFINITY;
            for (int i = 0; i < corners.length; i += 2) {
                float w = values[Matrix.MPERSP_0] * corners[i] + values[Matrix.MPERSP_1] * corners[i + 1] + values[Matrix.MPERSP_2];
                minimumW = Math.min(minimumW, w); maximumW = Math.max(maximumW, w);
            }
            if (minimumW <= 0.0f && maximumW >= 0.0f) return; // The projective horizon crosses the destination.
        }
        transform.mapPoints(corners);
        for (float coordinate : corners) if (!Float.isFinite(coordinate)) return;
        float minX = corners[0], maxX = corners[0], minY = corners[1], maxY = corners[1];
        for (int i = 2; i < corners.length; i += 2) {
            minX = Math.min(minX, corners[i]); maxX = Math.max(maxX, corners[i]);
            minY = Math.min(minY, corners[i + 1]); maxY = Math.max(maxY, corners[i + 1]);
        }
        if (maxX <= 0.0f || maxY <= 0.0f || minX >= bitmap.getWidth() || minY >= bitmap.getHeight()) return;
        int left = (int)Math.max(0.0, Math.floor(minX)), top = (int)Math.max(0.0, Math.floor(minY));
        int right = (int)Math.min(bitmap.getWidth(), Math.ceil(maxX)), bottom = (int)Math.min(bitmap.getHeight(), Math.ceil(maxY));
        Matrix inverse = new Matrix();
        if (!transform.invert(inverse)) return;
        boolean transformed = !transform.isIdentity();
        boolean filtered = paint != null && paint.isFilterBitmap() && (sourceWidth != destinationWidth || sourceHeight != destinationHeight || transformed);
        for (int y = top; y < bottom; y++) for (int x = left; x < right; x++) {
            if (!isPointVisible(x + 0.5f, y + 0.5f)) continue;
            float[] local = {x + 0.5f, y + 0.5f};
            inverse.mapPoints(local);
            float localX = local[0], localY = local[1];
            if (!Float.isFinite(localX) || !Float.isFinite(localY)) continue;
            if (localX < dst.left || localX >= dst.right || localY < dst.top || localY >= dst.bottom) continue;
            float sourceX = ((localX - dst.left) * sourceWidth / destinationWidth) - 0.5f;
            float sourceY = ((localY - dst.top) * sourceHeight / destinationHeight) - 0.5f;
            int color = filtered ? bilinear(snapshot, sourceWidth, sourceHeight, sourceX, sourceY) : nearest(snapshot, sourceWidth, sourceHeight, sourceX, sourceY);
            if (paint != null) color = withAlpha(color, paint.effectiveAlpha(color >>> 24));
            int alpha = color >>> 24;
            if (alpha == 255) bitmap.setPixel(x, y, color);
            else if (alpha != 0) bitmap.setPixel(x, y, over(color, bitmap.getPixel(x, y)));
        }
    }

    private void rasterize(RectF localBounds, LocalPixel pixel) {
        if (bitmap == null || bitmap.isRecycled() || localBounds.left > localBounds.right || localBounds.top > localBounds.bottom) return;
        Matrix transform = currentTransform();
        float[] localCorners = {localBounds.left, localBounds.top, localBounds.right, localBounds.top,
            localBounds.right, localBounds.bottom, localBounds.left, localBounds.bottom};
        if (transform.hasPerspective()) {
            float[] values = new float[9]; transform.getValues(values);
            float minW = Float.POSITIVE_INFINITY, maxW = Float.NEGATIVE_INFINITY;
            for (int i = 0; i < localCorners.length; i += 2) {
                float w = values[Matrix.MPERSP_0] * localCorners[i] + values[Matrix.MPERSP_1] * localCorners[i + 1] + values[Matrix.MPERSP_2];
                minW = Math.min(minW, w); maxW = Math.max(maxW, w);
            }
            if (minW <= 0.0f && maxW >= 0.0f) return;
        }
        transform.mapPoints(localCorners);
        for (float coordinate : localCorners) if (!Float.isFinite(coordinate)) return;
        float minX = localCorners[0], maxX = localCorners[0], minY = localCorners[1], maxY = localCorners[1];
        for (int i = 2; i < localCorners.length; i += 2) {
            minX = Math.min(minX, localCorners[i]); maxX = Math.max(maxX, localCorners[i]);
            minY = Math.min(minY, localCorners[i + 1]); maxY = Math.max(maxY, localCorners[i + 1]);
        }
        if (maxX <= 0.0f || maxY <= 0.0f || minX >= bitmap.getWidth() || minY >= bitmap.getHeight()) return;
        int left = (int)Math.max(0.0, Math.floor(minX)), top = (int)Math.max(0.0, Math.floor(minY));
        int right = (int)Math.min(bitmap.getWidth(), Math.ceil(maxX)), bottom = (int)Math.min(bitmap.getHeight(), Math.ceil(maxY));
        Matrix inverse = new Matrix(); if (!transform.invert(inverse)) return;
        for (int y = top; y < bottom; y++) for (int x = left; x < right; x++) {
            if (!isPointVisible(x + 0.5f, y + 0.5f)) continue;
            float[] local = {x + 0.5f, y + 0.5f}; inverse.mapPoints(local);
            if (!Float.isFinite(local[0]) || !Float.isFinite(local[1])) continue;
            if (local[0] >= localBounds.left && local[0] < localBounds.right && local[1] >= localBounds.top && local[1] < localBounds.bottom)
                pixel.draw(x, y, local[0], local[1]);
        }
    }

    private void drawPaintPixel(int x, int y, int color, Paint paint) {
        color = withAlpha(color, paint.effectiveAlpha(color >>> 24));
        int alpha = color >>> 24;
        if (alpha == 255) bitmap.setPixel(x, y, color);
        else if (alpha != 0) bitmap.setPixel(x, y, over(color, bitmap.getPixel(x, y)));
    }

    private static float strokeRadius(Paint paint) {
        float width = paint.getStrokeWidth();
        return (width == 0.0f ? 1.0f : width) * 0.5f;
    }

    private static void checkFinite(float... values) {
        for (float value : values) if (!Float.isFinite(value)) throw new IllegalArgumentException("Canvas coordinates must be finite");
    }

    @FunctionalInterface private interface LocalPixel { void draw(int x, int y, float localX, float localY); }

    private static final class CanvasState {
        private final Matrix matrix;
        private final List<ClipRegion> clips;
        private CanvasState() { matrix = new Matrix(); clips = new ArrayList<>(); }
        private CanvasState(CanvasState other) { matrix = new Matrix(other.matrix); clips = new ArrayList<>(other.clips); }
    }
    private record ClipRegion(float[] points, boolean exclude) {}

    private static int nearest(int[] pixels, int width, int height, float x, float y) {
        int ix = Math.max(0, Math.min(width - 1, Math.round(x)));
        int iy = Math.max(0, Math.min(height - 1, Math.round(y)));
        return pixels[iy * width + ix];
    }

    private static int bilinear(int[] pixels, int width, int height, float x, float y) {
        float clampedX = Math.max(0.0f, Math.min(width - 1.0f, x));
        float clampedY = Math.max(0.0f, Math.min(height - 1.0f, y));
        int x0 = (int)Math.floor(clampedX);
        int y0 = (int)Math.floor(clampedY);
        int x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        float fx = clampedX - x0;
        float fy = clampedY - y0;
        return interpolate(interpolate(pixels[y0 * width + x0], pixels[y0 * width + x1], fx), interpolate(pixels[y1 * width + x0], pixels[y1 * width + x1], fx), fy);
    }

    private static int interpolate(int first, int second, float amount) {
        int result = 0;
        for (int shift = 0; shift <= 24; shift += 8) {
            int value = Math.round(((first >>> shift) & 255) * (1.0f - amount) + ((second >>> shift) & 255) * amount);
            result |= value << shift;
        }
        return result;
    }

    private static int withAlpha(int color, int alpha) { return (color & 0x00ffffff) | (alpha << 24); }

    private static int over(int src, int dst) {
        int sa = src >>> 24, da = dst >>> 24, inverse = 255 - sa;
        int denominator = sa * 255 + da * inverse;
        if (denominator == 0) return 0;
        int result = ((denominator + 127) / 255) << 24;
        for (int shift = 0; shift <= 16; shift += 8) {
            int value = (((src >>> shift) & 255) * sa * 255 + ((dst >>> shift) & 255) * da * inverse + denominator / 2) / denominator;
            result |= value << shift;
        }
        return result;
    }
}
