package android.webkit;

/** Settings consumed by the browser WebView bridge. */
public class WebSettings {
    private boolean javaScriptEnabled;
    private boolean domStorageEnabled;
    private boolean blockNetworkImage;
    private boolean useWideViewPort;
    private boolean loadWithOverviewMode;
    private boolean includeCookiesOnIntercept;
    private String userAgentString = "Mozilla/5.0 (Suwayomi Browser WebView)";

    public boolean getJavaScriptEnabled() { return javaScriptEnabled; }
    public void setJavaScriptEnabled(boolean value) { javaScriptEnabled = value; }
    public boolean getDomStorageEnabled() { return domStorageEnabled; }
    public void setDomStorageEnabled(boolean value) { domStorageEnabled = value; }
    public boolean getBlockNetworkImage() { return blockNetworkImage; }
    public void setBlockNetworkImage(boolean value) { blockNetworkImage = value; }
    public boolean getUseWideViewPort() { return useWideViewPort; }
    public void setUseWideViewPort(boolean value) { useWideViewPort = value; }
    public boolean getLoadWithOverviewMode() { return loadWithOverviewMode; }
    public void setLoadWithOverviewMode(boolean value) { loadWithOverviewMode = value; }
    public boolean getIncludeCookiesOnIntercept() { return includeCookiesOnIntercept; }
    public void setIncludeCookiesOnIntercept(boolean value) { includeCookiesOnIntercept = value; }
    public String getUserAgentString() { return userAgentString; }
    public void setUserAgentString(String value) { userAgentString = value == null ? "" : value; }
}
