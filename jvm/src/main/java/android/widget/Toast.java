package android.widget;

import android.content.Context;
import java.util.Objects;

/** Non-native Android toast state for source code running in the browser JVM. */
public final class Toast {
    public static final int LENGTH_SHORT = 0;
    public static final int LENGTH_LONG = 1;

    private final Context context;
    private CharSequence text;
    private final int duration;
    private boolean shown;

    private Toast(Context context, CharSequence text, int duration) {
        this.context = context;
        this.text = text == null ? "" : text;
        this.duration = duration;
    }

    public static Toast makeText(Context context, CharSequence text, int duration) {
        Objects.requireNonNull(context);
        return new Toast(context, text, duration);
    }

    public static Toast makeText(Context context, int resourceId, int duration) {
        Objects.requireNonNull(context);
        return makeText(context, context.getString(resourceId), duration);
    }

    public void show() { shown = true; }
    public void cancel() { shown = false; }
    public void setText(CharSequence text) { this.text = text == null ? "" : text; }
    public void setText(int resourceId) { setText(context.getString(resourceId)); }

    /** State inspection used by browser-host compatibility probes; no desktop notification is emitted. */
    public CharSequence getText() { return text; }
    public int getDuration() { return duration; }
    public boolean isShown() { return shown; }
}
