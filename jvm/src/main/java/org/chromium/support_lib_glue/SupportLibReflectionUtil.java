package org.chromium.support_lib_glue;

import java.lang.reflect.InvocationHandler;

/**
 * Browser fallback for the AndroidX WebView support-library entry point.
 *
 * The extension API probes this class before using optional Chromium features
 * such as client-hint metadata, audio muting, and origin-scoped web-message
 * listeners. The browser host provides the ordinary WebView bridge itself;
 * reporting an empty feature set makes the extension use its supported
 * addJavascriptInterface/jsBridge fallbacks without pretending to be an
 * Android WebView provider.
 */
public final class SupportLibReflectionUtil {
    private SupportLibReflectionUtil() {}

    public static InvocationHandler createWebViewProviderFactory() {
        return (proxy, method, args) -> {
            return switch (method.getName()) {
                case "getSupportedFeatures" -> new String[] { "COOKIE_INTERCEPT" };
                case "getWebkitToCompatConverter" -> (InvocationHandler) (converter, converterMethod, converterArgs) -> {
                    if (!converterMethod.getName().equals("convertSettings") || converterArgs == null || converterArgs.length == 0) return null;
                    android.webkit.WebSettings settings = (android.webkit.WebSettings) converterArgs[0];
                    return (InvocationHandler) (boundary, boundaryMethod, boundaryArgs) -> {
                        if (boundaryMethod.getName().equals("setIncludeCookiesOnIntercept") && boundaryArgs != null && boundaryArgs.length > 0) {
                            settings.setIncludeCookiesOnIntercept(Boolean.TRUE.equals(boundaryArgs[0]));
                            return null;
                        }
                        if (boundaryMethod.getName().equals("getIncludeCookiesOnIntercept")) return settings.getIncludeCookiesOnIntercept();
                        if (boundaryMethod.getName().equals("equals")) return boundary == (boundaryArgs == null ? null : boundaryArgs[0]);
                        if (boundaryMethod.getName().equals("hashCode")) return System.identityHashCode(boundary);
                        return null;
                    };
                };
                case "equals" -> proxy == (args == null ? null : args[0]);
                case "hashCode" -> System.identityHashCode(proxy);
                case "toString" -> "BrowserWebViewProviderFactory";
                default -> null;
            };
        };
    }
}
