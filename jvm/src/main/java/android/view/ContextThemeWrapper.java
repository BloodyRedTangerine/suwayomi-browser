package android.view;

import android.content.Context;
import android.content.ContextWrapper;

/** Context wrapper retaining the theme resource id without a native Android theme system. */
public class ContextThemeWrapper extends ContextWrapper {
    private int themeResource;
    public ContextThemeWrapper() { this(null, 0); }
    public ContextThemeWrapper(Context base) { this(base, 0); }
    public ContextThemeWrapper(Context base, int themeResource) { super(base); this.themeResource = themeResource; }
    public int getThemeResId() { return themeResource; }
    public void setTheme(int resource) { themeResource = resource; }
}
