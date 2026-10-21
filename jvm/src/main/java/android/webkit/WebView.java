package android.webkit;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Handler;
import android.net.Uri;
import android.view.View;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.lang.reflect.Method;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import suwayomi.browser.BrowserTransport;

/**
 * Local WebView facade backed by an opaque browser iframe. It intentionally
 * implements the APIs used by current source extensions, not a fake Android
 * renderer or browser-profile cookie jar.
 */
public class WebView extends View {
    private static final AtomicInteger NEXT_SESSION = new AtomicInteger();
    private static final ClassLoader BROWSER_CLASS_LOADER = new ClassLoader(WebView.class.getClassLoader()) {
        @Override protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            if (name.equals("org.chromium.support_lib_glue.SupportLibReflectionUtil"))
                return org.chromium.support_lib_glue.SupportLibReflectionUtil.class;
            return super.loadClass(name, resolve);
        }
    };
    private final String session = "webview-" + NEXT_SESSION.incrementAndGet();
    private final WebSettings settings = new WebSettings();
    private final Map<String, Object> bridges = new LinkedHashMap<>();
    private WebViewClient client;
    private WebChromeClient chromeClient;
    private volatile boolean destroyed;
    private volatile Thread eventThread;

    public WebView(Context context) { super(context); }
    public static ClassLoader getWebViewClassLoader() { return BROWSER_CLASS_LOADER; }
    /**
     * Legacy Android WebView glue asks for this private factory on API levels
     * below P. The browser has no Chromium provider object, but returning the
     * browser WebView class gives the compatibility layer a stable loader so
     * it can feature-detect and cleanly fall back.
     */
    private static Object getFactory() { return new BrowserFactoryMarker(); }
    private static final class BrowserFactoryMarker {}
    public WebSettings getSettings() { return settings; }
    public void setWebViewClient(WebViewClient client) { this.client = client; }
    public void setWebChromeClient(WebChromeClient client) { this.chromeClient = client; }
    public void addJavascriptInterface(Object object, String name) { if (object != null && name != null) bridges.put(name, object); }

    public void loadDataWithBaseURL(String baseUrl, String data, String mimeType, String encoding, String historyUrl) {
        beginLoad("loadData", new JSONObject().put("baseUrl", baseUrl).put("html", data).put("mimeType", mimeType));
    }
    public void loadUrl(String url) { loadUrl(url, java.util.Collections.emptyMap()); }
    public void loadUrl(String url, Map<String, String> headers) {
        beginLoad("loadUrl", new JSONObject().put("url", url).put("headers", new JSONObject(headers)));
    }

    private void beginLoad(String action, JSONObject fields) {
        if (destroyed) throw new IllegalStateException("WebView is destroyed");
        try {
            command(new JSONObject().put("action", "create").put("session", session));
            // Install the event consumer before loadData: sandboxed documents
            // may have static resources that must run through the synchronous
            // WebViewClient callback before the page is created.
            startEvents();
            if (client != null) client.onPageStarted(this, fields.optString("url", fields.optString("baseUrl", "")), null);
            fields.put("action", action).put("session", session).put("userAgent", settings.getUserAgentString());
            command(fields);
        } catch (Exception error) { throw new IllegalStateException("Could not start browser WebView", error); }
    }

    private synchronized void startEvents() {
        if (eventThread != null) return;
        eventThread = new Thread(() -> {
            while (!destroyed) {
                try {
                    JSONObject response = command(new JSONObject().put("action", "awaitEvent").put("session", session));
                    JSONObject event = response.optJSONObject("event");
                    if (event == null) continue;
                    String type = event.optString("type", "");
                    if (type.equals("closed")) return;
                    if (type.equals("pageFinished")) { if (client != null) client.onPageFinished(this, event.optString("url", "")); continue; }
                    if (type.equals("bridge")) { dispatchBridge(event.optString("name", ""), event.optString("message", "")); continue; }
                    if (type.equals("mainFrameRequest")) { dispatchMainFrameRequest(event); continue; }
                    if (type.equals("resourceRequest")) { dispatchResourceRequest(event); continue; }
                    if (type.equals("error")) { if (client != null) client.onReceivedError(this, null, new WebResourceError(-1, event.optString("message", "WebView error"))); }
                } catch (Throwable error) {
                    if (!destroyed && client != null) client.onReceivedError(this, null, new WebResourceError(-1, error.toString()));
                    return;
                }
            }
        }, "browser-webview-events");
        eventThread.setDaemon(true); eventThread.start();
    }

    private void dispatchMainFrameRequest(JSONObject event) {
        String resourceId = event.optString("id", "");
        String url = event.optString("url", "");
        String method = event.optString("method", "GET");
        try {
            if (resourceId.isEmpty() || url.isEmpty()) throw new IllegalArgumentException("Browser WebView main-frame request is missing its id or URL");
            LinkedHashMap<String, String> headers = readHeaders(event.optJSONArray("headers"));
            putHeaderIfMissing(headers, "User-Agent", settings.getUserAgentString());
            boolean includeCookies = settings.getIncludeCookiesOnIntercept();
            if (includeCookies) {
                try { putHeaderIfMissing(headers, "Cookie", CookieManager.getInstance().getCookie(url)); }
                catch (IllegalStateException ignored) {}
            }
            WebResourceRequest request = new WebResourceRequest() {
                @Override public Uri getUrl() { return Uri.parse(url); }
                @Override public boolean isForMainFrame() { return true; }
                @Override public boolean isRedirect() { return false; }
                @Override public boolean hasGesture() { return false; }
                @Override public String getMethod() { return method; }
                @Override public Map<String, String> getRequestHeaders() { return java.util.Collections.unmodifiableMap(headers); }
            };
            WebResourceResponse intercepted = !destroyed && client != null ? client.shouldInterceptRequest(this, request) : null;
            JSONObject serialized = intercepted == null ? null : serializeResponse(intercepted);
            Object response = serialized == null ? JSONObject.NULL : serialized;
            if (serialized != null && includeCookies) importResponseCookies(url, serialized.optJSONArray("headers"));
            command(new JSONObject()
                .put("action", "mainFrameInterceptResult")
                .put("session", session)
                .put("resourceId", resourceId)
                .put("response", response));
        } catch (Throwable error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            try {
                command(new JSONObject()
                    .put("action", "mainFrameInterceptResult")
                    .put("session", session)
                    .put("resourceId", resourceId)
                    .put("error", message));
            } catch (Throwable ignored) {}
            if (client != null) client.onReceivedError(this, null, new WebResourceError(-1, message));
        }
    }

    private void dispatchResourceRequest(JSONObject event) throws Exception {
        String resourceId = event.optString("id", "");
        String url = event.optString("url", "");
        String method = event.optString("method", "GET");
        if (resourceId.isEmpty() || url.isEmpty()) throw new IllegalArgumentException("Browser WebView request is missing its id or URL");

        LinkedHashMap<String, String> visibleHeaders = readHeaders(event.optJSONArray("headers"));
        putHeaderIfMissing(visibleHeaders, "User-Agent", settings.getUserAgentString());
        String credentialsMode = event.optString("credentialsMode", "include");
        String requestOrigin = event.optString("requestOrigin", "");
        boolean credentialsAllowed = credentialsAllowed(url, requestOrigin, credentialsMode);
        if (!credentialsAllowed) removeHeader(visibleHeaders, "Cookie");
        String sourceCookie = null;
        if (credentialsAllowed) try { sourceCookie = CookieManager.getInstance().getCookie(url); } catch (IllegalStateException ignored) {}
        if (settings.getIncludeCookiesOnIntercept() && sourceCookie != null) putHeaderIfMissing(visibleHeaders, "Cookie", sourceCookie);
        WebResourceRequest webRequest = new WebResourceRequest() {
            @Override public Uri getUrl() { return Uri.parse(url); }
            @Override public boolean isForMainFrame() { return false; }
            @Override public boolean isRedirect() { return false; }
            @Override public boolean hasGesture() { return false; }
            @Override public String getMethod() { return method; }
            @Override public Map<String, String> getRequestHeaders() { return java.util.Collections.unmodifiableMap(visibleHeaders); }
        };

        JSONObject intercepted = null;
        if (!destroyed && client != null) {
            WebResourceResponse result = client.shouldInterceptRequest(this, webRequest);
            if (result != null) intercepted = serializeResponse(result);
        }

        // The broker always receives the source-owned cookie jar, independently
        // of whether cookies were requested in the callback's visible headers,
        // but only when the WebView request's credentials mode permits them.
        LinkedHashMap<String, String> outgoingHeaders = new LinkedHashMap<>(visibleHeaders);
        if (sourceCookie != null) putHeaderIfMissing(outgoingHeaders, "Cookie", sourceCookie);
        JSONObject networkRequest = new JSONObject()
            .put("url", url)
            .put("method", method)
            .put("headers", encodeHeaders(outgoingHeaders))
            .put("body", event.optString("body", ""));

        try {
            JSONObject result = command(new JSONObject()
                .put("action", "resourceResult")
                .put("session", session)
                .put("resourceId", resourceId)
                .put("request", networkRequest)
                .put("response", intercepted == null ? JSONObject.NULL : intercepted));
            if (result.optBoolean("deferred")) {
                JSONObject responseMeta = result.optJSONObject("responseMeta");
                if (credentialsAllowed && responseMeta != null) importResponseCookies(url, responseMeta.optJSONArray("headers"));
                return;
            }
            JSONObject response = result.optJSONObject("response");
            if (response == null) throw new IllegalStateException("Browser WebView network response is missing");
            response.put("url", url).put("requestMethod", method);
            if (credentialsAllowed && (!result.optBoolean("intercepted") || settings.getIncludeCookiesOnIntercept())) importResponseCookies(url, response.optJSONArray("headers"));
            command(new JSONObject()
                .put("action", "resourceComplete")
                .put("session", session)
                .put("resourceId", resourceId)
                .put("response", response));
        } catch (Throwable error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            try {
                command(new JSONObject()
                    .put("action", "resourceComplete")
                    .put("session", session)
                    .put("resourceId", resourceId)
                    .put("error", message));
            } catch (Throwable ignored) {}
            if (client != null) client.onReceivedError(this, webRequest, new WebResourceError(-1, message));
        }
    }

    private static LinkedHashMap<String, String> readHeaders(org.json.JSONArray entries) {
        LinkedHashMap<String, String> headers = new LinkedHashMap<>();
        if (entries == null) return headers;
        for (int i = 0; i < entries.length(); i++) {
            org.json.JSONArray pair = entries.optJSONArray(i);
            if (pair == null || pair.length() < 2) continue;
            String name = pair.optString(0, ""), value = pair.optString(1, "");
            if (!name.isEmpty()) headers.put(name, value);
        }
        return headers;
    }

    private static void putHeaderIfMissing(Map<String, String> headers, String name, String value) {
        if (value == null || value.isEmpty()) return;
        for (String existing : headers.keySet()) if (existing.equalsIgnoreCase(name)) return;
        headers.put(name, value);
    }

    private static void removeHeader(Map<String, String> headers, String name) {
        headers.keySet().removeIf(existing -> existing.equalsIgnoreCase(name));
    }

    private static boolean credentialsAllowed(String url, String requestOrigin, String mode) {
        if ("omit".equalsIgnoreCase(mode)) return false;
        if ("same-origin".equalsIgnoreCase(mode)) return sameOrigin(url, requestOrigin);
        return true;
    }

    private static boolean sameOrigin(String first, String second) {
        try {
            URI a = URI.create(first), b = URI.create(second);
            if (a.getScheme() == null || a.getHost() == null || b.getScheme() == null || b.getHost() == null) return false;
            return a.getScheme().equalsIgnoreCase(b.getScheme())
                && a.getHost().equalsIgnoreCase(b.getHost())
                && effectivePort(a) == effectivePort(b);
        } catch (RuntimeException ignored) { return false; }
    }

    private static int effectivePort(URI url) {
        if (url.getPort() >= 0) return url.getPort();
        return "https".equalsIgnoreCase(url.getScheme()) ? 443 : 80;
    }

    private static org.json.JSONArray encodeHeaders(Map<String, String> headers) {
        org.json.JSONArray result = new org.json.JSONArray();
        headers.forEach((name, value) -> result.put(new org.json.JSONArray().put(name).put(value)));
        return result;
    }

    private static JSONObject serializeResponse(WebResourceResponse response) throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        if (response.getResponseHeaders() != null) headers.putAll(response.getResponseHeaders());
        if (response.getMimeType() != null) {
            String contentType = response.getMimeType();
            if (response.getEncoding() != null && !response.getEncoding().isEmpty()) contentType += "; charset=" + response.getEncoding();
            putHeaderIfMissing(headers, "Content-Type", contentType);
        }
        byte[] body = readAll(response.getData());
        return new JSONObject()
            .put("status", response.getStatusCode())
            .put("statusText", response.getReasonPhrase() == null ? "" : response.getReasonPhrase())
            .put("headers", encodeHeaders(headers))
            .put("body", Base64.getEncoder().encodeToString(body));
    }

    private static byte[] readAll(InputStream stream) throws Exception {
        if (stream == null) return new byte[0];
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    private static void importResponseCookies(String url, org.json.JSONArray headers) {
        if (headers == null) return;
        for (int i = 0; i < headers.length(); i++) {
            org.json.JSONArray pair = headers.optJSONArray(i);
            if (pair == null || pair.length() < 2 || !"set-cookie".equalsIgnoreCase(pair.optString(0, ""))) continue;
            try { CookieManager.getInstance().setCookie(url, pair.optString(1, "")); } catch (IllegalStateException ignored) {}
        }
    }

    private void dispatchBridge(String name, String message) throws Exception {
        Object bridge = bridges.get(name);
        if (bridge == null) return;
        Method callback = null;
        for (Method method : bridge.getClass().getMethods()) if (method.getName().equals("post") && method.getParameterCount() == 1) { callback = method; break; }
        if (callback == null) throw new NoSuchMethodException("WebView bridge has no post(String): " + name);
        callback.setAccessible(true);
        callback.invoke(bridge, message);
    }

    public void evaluateJavascript(String script, ValueCallback<String> callback) {
        Runnable task = () -> {
            try {
                JSONObject response = command(new JSONObject().put("action", "evaluate").put("session", session).put("script", script));
                if (response.has("error")) throw new IllegalStateException(response.getString("error"));
                if (callback != null) callback.onReceiveValue(response.optString("value", "null"));
            } catch (Throwable error) { if (callback != null) callback.onReceiveValue("null"); }
        };
        new Handler().post(task);
    }

    public void stopLoading() {}
    public void destroy() {
        if (destroyed) return;
        destroyed = true;
        try { command(new JSONObject().put("action", "close").put("session", session)); } catch (Throwable ignored) {}
        Thread thread = eventThread; if (thread != null) thread.interrupt();
    }

    private static JSONObject command(JSONObject request) throws Exception {
        JSONObject response = new JSONObject(BrowserTransport.webView(request.toString()));
        if (response.has("error")) throw new IllegalStateException(response.getString("error"));
        return response;
    }
}
