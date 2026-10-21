package android.preference;

import android.content.Context;
import android.content.SharedPreferences;

/** Android's default preference namespace, persisted by the browser Context. */
public final class PreferenceManager {
    private PreferenceManager() {}
    public static SharedPreferences getDefaultSharedPreferences(Context context) {
        return context.getSharedPreferences(getDefaultSharedPreferencesName(context), getDefaultSharedPreferencesMode());
    }
    public static String getDefaultSharedPreferencesName(Context context) { return context.getPackageName() + "_preferences"; }
    public static int getDefaultSharedPreferencesMode() { return Context.MODE_PRIVATE; }
}
