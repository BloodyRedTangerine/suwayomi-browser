package android.view;

import android.content.Context;
import java.util.ArrayList;
import java.util.List;

/** Non-rendered container shell needed by extension WebView lifecycle code. */
public class ViewGroup extends View implements ViewParent {
    private final List<View> children = new ArrayList<>();
    public ViewGroup(Context context) { super(context); }
    public void addView(View child) { addView(child, children.size()); }
    public void addView(View child, LayoutParams params) { child.setLayoutParams(params); addView(child); }
    public void addView(View child, int index) {
        if (child == null) throw new NullPointerException("child");
        if (index < 0 || index > children.size()) throw new IndexOutOfBoundsException(index);
        if (child == this) throw new IllegalArgumentException("A ViewGroup cannot contain itself");
        if (child.getParent() instanceof ViewGroup oldParent) oldParent.removeView(child);
        children.add(index, child); child.setParent(this);
    }
    public void removeView(View child) { if (child != null && children.remove(child)) child.setParent(null); }
    public void removeViewAt(int index) { View child = children.remove(index); child.setParent(null); }
    public void removeAllViews() { for (View child : children) child.setParent(null); children.clear(); }
    public int getChildCount() { return children.size(); }
    public View getChildAt(int index) { return index < 0 || index >= children.size() ? null : children.get(index); }
    public int indexOfChild(View child) { return children.indexOf(child); }
    @Override @SuppressWarnings("unchecked") public <T extends View> T findViewById(int id) {
        T own = super.findViewById(id);
        if (own != null) return own;
        for (View child : children) { T found = child.findViewById(id); if (found != null) return found; }
        return null;
    }
    public static class LayoutParams {
        public int width, height;
        public LayoutParams(int width, int height) { this.width = width; this.height = height; }
    }
}
