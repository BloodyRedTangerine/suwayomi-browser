package android.text;

/** StringBuilder-backed Editable sufficient for source preference controls. */
public final class SpannableStringBuilder implements Editable {
    private final StringBuilder value;
    public SpannableStringBuilder() { value = new StringBuilder(); }
    public SpannableStringBuilder(CharSequence text) { value = new StringBuilder(text == null ? "" : text); }
    @Override public SpannableStringBuilder replace(int start, int end, CharSequence replacement) {
        value.replace(start, end, replacement == null ? "" : replacement.toString()); return this;
    }
    @Override public SpannableStringBuilder append(CharSequence text) { value.append(text); return this; }
    @Override public SpannableStringBuilder delete(int start, int end) { value.delete(start, end); return this; }
    @Override public int length() { return value.length(); }
    @Override public char charAt(int index) { return value.charAt(index); }
    @Override public CharSequence subSequence(int start, int end) { return value.subSequence(start, end); }
    @Override public String toString() { return value.toString(); }
}
