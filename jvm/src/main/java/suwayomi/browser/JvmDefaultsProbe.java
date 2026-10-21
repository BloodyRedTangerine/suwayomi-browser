package suwayomi.browser;

import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

public final class JvmDefaultsProbe {
    public static String snapshot() {
        Map<String, String> values = new LinkedHashMap<>();
        values.put("locale.default", Locale.getDefault().toLanguageTag());
        for (Locale.Category category : Locale.Category.values())
            values.put("locale." + category.name(), Locale.getDefault(category).toLanguageTag());
        values.put("timezone.default", TimeZone.getDefault().getID());
        values.put("zoneId.default", ZoneId.systemDefault().getId());
        for (String property : new String[]{"user.language", "user.country", "user.timezone", "file.encoding"})
            values.put(property, System.getProperty(property));
        StringBuilder json = new StringBuilder("{");
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (json.length() > 1) json.append(',');
            json.append(quote(entry.getKey())).append(':').append(quote(entry.getValue()));
        }
        return json.append('}').toString();
    }
    private static String quote(String value) {
        return value == null ? "null" : "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }
}
