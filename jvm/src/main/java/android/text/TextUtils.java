package android.text;
import java.util.Iterator;
import java.util.regex.Pattern;

public final class TextUtils {
    public static boolean isEmpty(CharSequence value) { return value == null || value.length() == 0; }
    public static boolean equals(CharSequence first, CharSequence second) {
        if (first == second) return true;
        if (first == null || second == null || first.length() != second.length()) return false;
        for (int i = 0; i < first.length(); i++) if (first.charAt(i) != second.charAt(i)) return false;
        return true;
    }
    public static String join(CharSequence separator, Iterable<?> values) {
        StringBuilder builder = new StringBuilder();
        Iterator<?> iterator = values.iterator();
        while (iterator.hasNext()) { builder.append(iterator.next()); if (iterator.hasNext()) builder.append(separator); }
        return builder.toString();
    }
    public static String join(CharSequence separator, Object[] values) { return join(separator, java.util.Arrays.asList(values)); }
    public static String[] split(String value, String expression) { return value.isEmpty() ? new String[0] : value.split(expression, -1); }
    public static String[] split(String value, Pattern pattern) { return value.isEmpty() ? new String[0] : pattern.split(value, -1); }
    public static String htmlEncode(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }
    public enum TruncateAt { START, MIDDLE, END, MARQUEE }
}
