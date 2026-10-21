package android.graphics;

import java.util.Arrays;

/** Browser software implementation of Android's 3x3 transform matrix API. */
public final class Matrix {
    public static final int MSCALE_X = 0, MSKEW_X = 1, MTRANS_X = 2;
    public static final int MSKEW_Y = 3, MSCALE_Y = 4, MTRANS_Y = 5;
    public static final int MPERSP_0 = 6, MPERSP_1 = 7, MPERSP_2 = 8;

    private final float[] values = new float[9];

    public Matrix() { reset(); }
    public Matrix(Matrix source) { set(source); }

    public void reset() {
        Arrays.fill(values, 0.0f);
        values[MSCALE_X] = values[MSCALE_Y] = values[MPERSP_2] = 1.0f;
    }

    public void set(Matrix source) {
        if (source == null) reset(); else System.arraycopy(source.values, 0, values, 0, values.length);
    }

    public boolean isIdentity() {
        return values[MSCALE_X] == 1.0f && values[MSCALE_Y] == 1.0f &&
            values[MSKEW_X] == 0.0f && values[MSKEW_Y] == 0.0f &&
            values[MTRANS_X] == 0.0f && values[MTRANS_Y] == 0.0f &&
            values[MPERSP_0] == 0.0f && values[MPERSP_1] == 0.0f && values[MPERSP_2] == 1.0f;
    }

    public void setValues(float[] source) {
        if (source == null || source.length < 9) throw new IllegalArgumentException("Matrix values need nine entries");
        for (int i = 0; i < 9; i++) if (!Float.isFinite(source[i])) throw new IllegalArgumentException("Matrix values must be finite");
        System.arraycopy(source, 0, values, 0, values.length);
    }

    public void getValues(float[] destination) {
        if (destination == null || destination.length < 9) throw new IllegalArgumentException("Matrix values need nine entries");
        System.arraycopy(values, 0, destination, 0, values.length);
    }

    public void setTranslate(float dx, float dy) { reset(); values[MTRANS_X] = finite(dx); values[MTRANS_Y] = finite(dy); }
    public void setScale(float sx, float sy) { setScale(sx, sy, 0.0f, 0.0f); }
    public void setScale(float sx, float sy, float px, float py) {
        finite(sx); finite(sy); finite(px); finite(py); reset();
        values[MSCALE_X] = sx; values[MSCALE_Y] = sy;
        values[MTRANS_X] = px - sx * px; values[MTRANS_Y] = py - sy * py;
        ensureFinite(values[MTRANS_X]); ensureFinite(values[MTRANS_Y]);
    }
    public void setRotate(float degrees) { setRotate(degrees, 0.0f, 0.0f); }
    public void setRotate(float degrees, float px, float py) {
        finite(degrees); finite(px); finite(py);
        double normalizedDegrees = Math.IEEEremainder((double)degrees, 360.0);
        double quarterTurns = normalizedDegrees / 90.0;
        double nearestQuarterTurn = Math.rint(quarterTurns);
        float cosine, sine;
        if (Math.abs(quarterTurns - nearestQuarterTurn) < 1.0e-7) {
            int quadrant = Math.floorMod((int)nearestQuarterTurn, 4);
            cosine = switch (quadrant) { case 0 -> 1.0f; case 2 -> -1.0f; default -> 0.0f; };
            sine = switch (quadrant) { case 1 -> 1.0f; case 3 -> -1.0f; default -> 0.0f; };
        } else {
            double radians = Math.toRadians(normalizedDegrees);
            cosine = (float)Math.cos(radians); sine = (float)Math.sin(radians);
        }
        reset(); values[MSCALE_X] = cosine; values[MSKEW_X] = -sine;
        values[MSKEW_Y] = sine; values[MSCALE_Y] = cosine;
        values[MTRANS_X] = px - cosine * px + sine * py;
        values[MTRANS_Y] = py - sine * px - cosine * py;
        ensureFinite(values[MTRANS_X]); ensureFinite(values[MTRANS_Y]);
    }
    public void setSkew(float kx, float ky) { setSkew(kx, ky, 0.0f, 0.0f); }
    public void setSkew(float kx, float ky, float px, float py) {
        finite(kx); finite(ky); finite(px); finite(py); reset();
        values[MSKEW_X] = kx; values[MSKEW_Y] = ky;
        values[MTRANS_X] = -kx * py; values[MTRANS_Y] = -ky * px;
        ensureFinite(values[MTRANS_X]); ensureFinite(values[MTRANS_Y]);
    }

    public boolean setConcat(Matrix a, Matrix b) {
        if (a == null || b == null) { reset(); return false; }
        set(multiply(a.values, b.values)); return true;
    }
    public boolean preConcat(Matrix other) { return concat(other, false); }
    public boolean postConcat(Matrix other) { return concat(other, true); }
    private boolean concat(Matrix other, boolean before) {
        if (other == null) return false;
        set(before ? multiply(other.values, values) : multiply(values, other.values)); return true;
    }

    public boolean preTranslate(float dx, float dy) { return apply(operationTranslate(dx, dy), false); }
    public boolean postTranslate(float dx, float dy) { return apply(operationTranslate(dx, dy), true); }
    public boolean preScale(float sx, float sy) { return preScale(sx, sy, 0.0f, 0.0f); }
    public boolean preScale(float sx, float sy, float px, float py) { return apply(operationScale(sx, sy, px, py), false); }
    public boolean postScale(float sx, float sy) { return postScale(sx, sy, 0.0f, 0.0f); }
    public boolean postScale(float sx, float sy, float px, float py) { return apply(operationScale(sx, sy, px, py), true); }
    public boolean preRotate(float degrees) { return preRotate(degrees, 0.0f, 0.0f); }
    public boolean preRotate(float degrees, float px, float py) { return apply(operationRotate(degrees, px, py), false); }
    public boolean postRotate(float degrees) { return postRotate(degrees, 0.0f, 0.0f); }
    public boolean postRotate(float degrees, float px, float py) { return apply(operationRotate(degrees, px, py), true); }
    public boolean preSkew(float kx, float ky) { return preSkew(kx, ky, 0.0f, 0.0f); }
    public boolean preSkew(float kx, float ky, float px, float py) { return apply(operationSkew(kx, ky, px, py), false); }
    public boolean postSkew(float kx, float ky) { return postSkew(kx, ky, 0.0f, 0.0f); }
    public boolean postSkew(float kx, float ky, float px, float py) { return apply(operationSkew(kx, ky, px, py), true); }

    private boolean apply(float[] operation, boolean before) {
        set(before ? multiply(operation, values) : multiply(values, operation)); return true;
    }
    private static float[] operationTranslate(float dx, float dy) {
        float[] result = identity(); result[MTRANS_X] = finite(dx); result[MTRANS_Y] = finite(dy); return result;
    }
    private static float[] operationScale(float sx, float sy, float px, float py) {
        Matrix matrix = new Matrix(); matrix.setScale(sx, sy, px, py); return matrix.values;
    }
    private static float[] operationRotate(float degrees, float px, float py) {
        Matrix matrix = new Matrix(); matrix.setRotate(degrees, px, py); return matrix.values;
    }
    private static float[] operationSkew(float kx, float ky, float px, float py) {
        Matrix matrix = new Matrix(); matrix.setSkew(kx, ky, px, py); return matrix.values;
    }

    public boolean invert(Matrix inverse) {
        if (inverse == null) return false;
        double a = values[0], b = values[1], c = values[2];
        double d = values[3], e = values[4], f = values[5];
        double g = values[6], h = values[7], i = values[8];
        double c00 = e * i - f * h, c01 = f * g - d * i, c02 = d * h - e * g;
        double c10 = c * h - b * i, c11 = a * i - c * g, c12 = b * g - a * h;
        double c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d;
        double determinant = a * c00 + b * c01 + c * c02;
        if (!Double.isFinite(determinant) || determinant == 0.0) return false;
        double reciprocal = 1.0 / determinant;
        float[] result = {
            (float)(c00 * reciprocal), (float)(c10 * reciprocal), (float)(c20 * reciprocal),
            (float)(c01 * reciprocal), (float)(c11 * reciprocal), (float)(c21 * reciprocal),
            (float)(c02 * reciprocal), (float)(c12 * reciprocal), (float)(c22 * reciprocal),
        };
        for (float value : result) if (!Float.isFinite(value)) return false;
        inverse.set(result);
        return true;
    }

    public void mapPoints(float[] points) { mapPoints(points, 0, points, 0, points.length / 2); }
    public void mapPoints(float[] destination, int destinationIndex, float[] source, int sourceIndex, int pointCount) {
        validatePoints(destination, destinationIndex, source, sourceIndex, pointCount);
        for (int i = 0; i < pointCount; i++) {
            float x = source[sourceIndex + i * 2], y = source[sourceIndex + i * 2 + 1];
            float denominator = values[MPERSP_0] * x + values[MPERSP_1] * y + values[MPERSP_2];
            float mappedX = values[MSCALE_X] * x + values[MSKEW_X] * y + values[MTRANS_X];
            float mappedY = values[MSKEW_Y] * x + values[MSCALE_Y] * y + values[MTRANS_Y];
            destination[destinationIndex + i * 2] = mappedX / denominator;
            destination[destinationIndex + i * 2 + 1] = mappedY / denominator;
        }
    }
    public void mapVectors(float[] vectors) { mapVectors(vectors, 0, vectors, 0, vectors.length / 2); }
    public void mapVectors(float[] destination, int destinationIndex, float[] source, int sourceIndex, int vectorCount) {
        validatePoints(destination, destinationIndex, source, sourceIndex, vectorCount);
        double denominator = values[MPERSP_2];
        double denominatorSquared = denominator * denominator;
        double xx = (values[MSCALE_X] * denominator - values[MPERSP_0] * values[MTRANS_X]) / denominatorSquared;
        double xy = (values[MSKEW_X] * denominator - values[MPERSP_1] * values[MTRANS_X]) / denominatorSquared;
        double yx = (values[MSKEW_Y] * denominator - values[MPERSP_0] * values[MTRANS_Y]) / denominatorSquared;
        double yy = (values[MSCALE_Y] * denominator - values[MPERSP_1] * values[MTRANS_Y]) / denominatorSquared;
        for (int i = 0; i < vectorCount; i++) {
            float x = source[sourceIndex + i * 2], y = source[sourceIndex + i * 2 + 1];
            destination[destinationIndex + i * 2] = (float)(xx * x + xy * y);
            destination[destinationIndex + i * 2 + 1] = (float)(yx * x + yy * y);
        }
    }
    public boolean mapRect(RectF destination, RectF source) {
        if (destination == null || source == null) throw new NullPointerException("rect");
        float[] corners = {source.left, source.top, source.right, source.top, source.right, source.bottom, source.left, source.bottom};
        mapPoints(corners);
        float left = corners[0], right = corners[0], top = corners[1], bottom = corners[1];
        for (int i = 2; i < corners.length; i += 2) {
            left = Math.min(left, corners[i]); right = Math.max(right, corners[i]);
            top = Math.min(top, corners[i + 1]); bottom = Math.max(bottom, corners[i + 1]);
        }
        destination.set(left, top, right, bottom);
        return rectStaysRect();
    }
    public boolean mapRect(RectF rect) { return mapRect(rect, rect); }
    public boolean rectStaysRect() {
        if (values[MPERSP_0] != 0.0f || values[MPERSP_1] != 0.0f || values[MPERSP_2] != 1.0f) return false;
        boolean straight = values[MSKEW_X] == 0.0f && values[MSKEW_Y] == 0.0f;
        boolean quarterTurn = values[MSCALE_X] == 0.0f && values[MSCALE_Y] == 0.0f;
        return straight || quarterTurn;
    }
    public boolean hasPerspective() { return values[MPERSP_0] != 0.0f || values[MPERSP_1] != 0.0f || values[MPERSP_2] != 1.0f; }

    private static void validatePoints(float[] destination, int destinationIndex, float[] source, int sourceIndex, int count) {
        if (destination == null || source == null || destinationIndex < 0 || sourceIndex < 0 || count < 0 ||
            (long)destinationIndex + 2L * count > destination.length || (long)sourceIndex + 2L * count > source.length)
            throw new ArrayIndexOutOfBoundsException("Invalid Matrix point array window");
    }
    static float[] multiply(float[] left, float[] right) {
        float[] result = new float[9];
        for (int row = 0; row < 3; row++) for (int column = 0; column < 3; column++) {
            double value = 0.0;
            for (int inner = 0; inner < 3; inner++) value += (double)left[row * 3 + inner] * right[inner * 3 + column];
            result[row * 3 + column] = finite((float)value);
        }
        return result;
    }
    private void set(float[] source) { System.arraycopy(source, 0, values, 0, values.length); }
    private static float[] identity() {
        float[] result = new float[9]; result[MSCALE_X] = result[MSCALE_Y] = result[MPERSP_2] = 1.0f; return result;
    }
    private static float finite(float value) {
        if (!Float.isFinite(value)) throw new IllegalArgumentException("Matrix values must be finite");
        return value;
    }
    private static void ensureFinite(float value) { finite(value); }
}
