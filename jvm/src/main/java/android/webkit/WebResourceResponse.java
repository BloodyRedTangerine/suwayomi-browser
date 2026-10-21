package android.webkit;

import java.io.InputStream;
import java.util.Map;

/** Response container for the optional source request interception API. */
public class WebResourceResponse {
    private final String mimeType, encoding;
    private final int statusCode;
    private final String reasonPhrase;
    private final Map<String, String> responseHeaders;
    private final InputStream data;
    public WebResourceResponse(String mimeType, String encoding, InputStream data) { this(mimeType, encoding, 200, "OK", null, data); }
    public WebResourceResponse(String mimeType, String encoding, int statusCode, String reasonPhrase, Map<String, String> responseHeaders, InputStream data) {
        this.mimeType = mimeType; this.encoding = encoding; this.statusCode = statusCode; this.reasonPhrase = reasonPhrase; this.responseHeaders = responseHeaders; this.data = data;
    }
    public String getMimeType() { return mimeType; }
    public String getEncoding() { return encoding; }
    public int getStatusCode() { return statusCode; }
    public String getReasonPhrase() { return reasonPhrase; }
    public Map<String, String> getResponseHeaders() { return responseHeaders; }
    public InputStream getData() { return data; }
}
