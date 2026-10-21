package android.os;

/** Browser host identity; no native Android device or API-level claim. */
public final class Build {
    private Build() {}
    public static final String MODEL = "Browser WASM";
    public static final String MANUFACTURER = "Suwayomi Browser";
    public static final String ID = "SuwayomiBrowser";
    public static final String[] SUPPORTED_ABIS = { "wasm32" };
    public static final class VERSION {
        public static final String RELEASE = "Browser";
        // Advertise the WebView class-loader API branch used by current
        // extensions. This is an API-surface compatibility value, not a
        // claim that the browser is an Android device or exposes Chromium's
        // support-library provider.
        public static final int SDK_INT = 28;
        private VERSION() {}
    }
}
