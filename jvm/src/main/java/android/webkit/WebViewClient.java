package android.webkit;

import android.graphics.Bitmap;

public class WebViewClient {
    public void onPageStarted(WebView view, String url, Bitmap favicon) {}
    public void onPageFinished(WebView view, String url) {}
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return null; }
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {}
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { return false; }
}
