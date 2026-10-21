package android.text;

/** Plain immutable span-free text. Browser source rendering retains semantic text, not Android spans. */
public final class SpannedString implements Spanned {
    private final String value;
    public SpannedString(CharSequence value) { this.value = value == null ? "" : value.toString(); }
    @Override public int length() { return value.length(); }
    @Override public char charAt(int index) { return value.charAt(index); }
    @Override public CharSequence subSequence(int start, int end) { return value.subSequence(start, end); }
    @Override public String toString() { return value; }
    @Override @SuppressWarnings("unchecked") public <T> T[] getSpans(int start, int end, Class<T> type) { return (T[])java.lang.reflect.Array.newInstance(type, 0); }
    @Override public int getSpanStart(Object tag) { return -1; }
    @Override public int getSpanEnd(Object tag) { return -1; }
    @Override public int getSpanFlags(Object tag) { return 0; }
    @Override public int nextSpanTransition(int start, int limit, Class<?> type) { return limit; }
}
