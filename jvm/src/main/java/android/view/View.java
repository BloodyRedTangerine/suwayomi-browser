package android.view;

import android.content.Context;

/** Minimal non-rendered View base used by the browser WebView compatibility layer. */
public class View {
    private final Context context;
    private ViewParent parent;
    private ViewGroup.LayoutParams layoutParams;
    private int id;
    private boolean enabled = true;
    private int visibility = VISIBLE;

    public static final int VISIBLE = 0, INVISIBLE = 4, GONE = 8;

    public View(Context context) { this.context = context; }
    public Context getContext() { return context; }
    public ViewParent getParent() { return parent; }
    void setParent(ViewParent parent) { this.parent = parent; }
    public void setId(int id) { this.id = id; }
    public int getId() { return id; }
    public <T extends View> T findViewById(int id) { return this.id == id ? (T)this : null; }
    public View getRootView() {
        View root = this;
        while (root.parent instanceof View view) root = view;
        return root;
    }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public boolean isEnabled() { return enabled; }
    public void setVisibility(int visibility) {
        if (visibility != VISIBLE && visibility != INVISIBLE && visibility != GONE) throw new IllegalArgumentException("Invalid view visibility");
        this.visibility = visibility;
    }
    public int getVisibility() { return visibility; }
    public ViewGroup.LayoutParams getLayoutParams() { return layoutParams; }
    public void setLayoutParams(ViewGroup.LayoutParams params) { layoutParams = params; }
    public void measure(int widthMeasureSpec, int heightMeasureSpec) {}
    public void layout(int left, int top, int right, int bottom) {}
    public void setBackgroundColor(int color) {}
    public boolean post(Runnable runnable) { new Thread(runnable, "browser-view-callback").start(); return true; }

    public static class MeasureSpec {
        public static final int EXACTLY = 0x40000000;
        public static int makeMeasureSpec(int size, int mode) { return (size & 0x3fffffff) | (mode & 0xc0000000); }
    }
}
