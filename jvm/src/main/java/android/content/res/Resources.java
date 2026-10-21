package android.content.res;

import android.util.DisplayMetrics;

/** Minimal process-wide resource facade for browser-hosted source code. */
public class Resources {
    private static final Resources SYSTEM = new Resources();
    private final DisplayMetrics metrics = new DisplayMetrics();

    public static Resources getSystem() { return SYSTEM; }
    public DisplayMetrics getDisplayMetrics() { return metrics; }
}
