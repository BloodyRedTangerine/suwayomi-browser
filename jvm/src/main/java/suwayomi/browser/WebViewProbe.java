package suwayomi.browser;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebResourceResponse;
import eu.kanade.tachiyomi.network.PersistentCookieStore;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Cross-layer browser WebView probe: JVM facade, sandboxed DOM and JS bridge. */
public final class WebViewProbe {
    private static byte[] loadProbeFont() {
        try (InputStream font = BrowserResources.loader(WebViewProbe.class).getResourceAsStream("suwayomi/browser/probe-font.ttf")) {
            if (font == null) throw new IllegalStateException("Packaged WebView font probe is missing");
            return font.readAllBytes();
        } catch (Exception error) { throw new IllegalStateException("Could not load packaged WebView font probe", error); }
    }

    public static String verify() throws Exception {
        CountDownLatch bridgeDone = new CountDownLatch(1);
        CountDownLatch pageDone = new CountDownLatch(1);
        CountDownLatch evaluated = new CountDownLatch(1);
        AtomicReference<String> bridgeValue = new AtomicReference<>();
        AtomicReference<String> evaluation = new AtomicReference<>();
        AtomicReference<String> webViewError = new AtomicReference<>();
        AtomicReference<Integer> intercepted = new AtomicReference<>(0);
        AtomicReference<String> sameOriginSriCookie = new AtomicReference<>();
        AtomicReference<String> anonymousSriHeaders = new AtomicReference<>();
        AtomicReference<String> credentialedSriHeaders = new AtomicReference<>();
        AtomicReference<String> networkSriHeaders = new AtomicReference<>();
        AtomicReference<String> networkSriScriptHeaders = new AtomicReference<>();
        AtomicReference<String> upgradedImageUrl = new AtomicReference<>();
        AtomicReference<String> upgradedDynamicImageUrl = new AtomicReference<>();
        AtomicReference<String> upgradedFetchUrl = new AtomicReference<>();
        AtomicReference<Integer> noCorsSriRequests = new AtomicReference<>(0);
        PersistentCookieStore previousCookieStore = WebViewCookieStoreProbe.bind();
        WebView view = new WebView(new Context());
        view.getSettings().setIncludeCookiesOnIntercept(true);
        CookieManager.getInstance().setCookie("https://webview.example.test/", "wv_sri_same=1; Path=/; Max-Age=3600; Secure");
        CookieManager.getInstance().setCookie("https://cdn.example.test/", "wv_sri_cdn=1; Path=/; Max-Age=3600; Secure");
        view.setWebViewClient(new android.webkit.WebViewClient() {
            @Override public void onPageFinished(WebView ignored, String url) { pageDone.countDown(); }
            @Override public void onReceivedError(WebView ignored, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) { webViewError.set(String.valueOf(error == null ? null : error.getDescription())); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, android.webkit.WebResourceRequest request) {
                String path = request.getUrl().getPath();
                if (!"/@waf/probe".equals(path) && !"/@waf/xhr-probe".equals(path) && !"/@waf/xhr-charset".equals(path) && !"/@waf/xhr-override-charset".equals(path) && !"/@waf/xhr-arraybuffer".equals(path) && !"/@waf/probe.css".equals(path) && !"/@waf/nested.css".equals(path) && !"/@waf/probe-font.ttf".equals(path) && !"/@waf/background.svg".equals(path) && !"/@waf/inline-style.svg".equals(path) && !"/@waf/inline-attr.svg".equals(path) && !"/@waf/intercepted.js".equals(path) && !"/@waf/csp-before-meta.js".equals(path) && !"/@waf/deferred-first.js".equals(path) && !"/@waf/deferred-second.js".equals(path) && !"/@waf/async-first.js".equals(path) && !"/@waf/async-second.js".equals(path) && !"/@waf/csp-upgrade-image.svg".equals(path) && !"/@waf/csp-upgrade-dynamic-image.svg".equals(path) && !"/@waf/csp-upgrade-fetch".equals(path) && !"/@waf/static-image.svg".equals(path) && !"/@waf/dynamic-image.svg".equals(path) && !"/@waf/cross-origin-image.svg".equals(path) && !"/@waf/cors-image.svg".equals(path) && !"/@waf/srcset-image.svg".equals(path) && !"/@waf/picture-image.svg".equals(path) && !"/@waf/dynamic-srcset-image.svg".equals(path) && !"/@waf/sri.css".equals(path) && !path.startsWith("/@waf/sri-")) return null;
                intercepted.set(intercepted.get() + 1);
                if ("/@waf/csp-upgrade-image.svg".equals(path)) upgradedImageUrl.set(request.getUrl().toString());
                if ("/@waf/csp-upgrade-dynamic-image.svg".equals(path)) upgradedDynamicImageUrl.set(request.getUrl().toString());
                if ("/@waf/csp-upgrade-fetch".equals(path)) {
                    upgradedFetchUrl.set(request.getUrl().toString());
                    return new WebResourceResponse("text/plain", "UTF-8", 200, "OK", null,
                        new ByteArrayInputStream("upgrade-ok".getBytes(StandardCharsets.UTF_8)));
                }
                if ("/@waf/sri.css".equals(path)) sameOriginSriCookie.set(request.getRequestHeaders().get("Cookie"));
                if ("/@waf/sri-anon.css".equals(path)) anonymousSriHeaders.set(request.getRequestHeaders().get("Cookie") + "|" + request.getRequestHeaders().get("Origin"));
                if ("/@waf/sri-credentials.css".equals(path)) credentialedSriHeaders.set(request.getRequestHeaders().get("Cookie") + "|" + request.getRequestHeaders().get("Origin"));
                if ("/@waf/sri-network.css".equals(path)) networkSriHeaders.set(request.getRequestHeaders().get("Cookie") + "|" + request.getRequestHeaders().get("Origin"));
                if ("/@waf/sri-script-network.js".equals(path)) networkSriScriptHeaders.set(request.getRequestHeaders().get("Cookie") + "|" + request.getRequestHeaders().get("Origin"));
                if ("/@waf/sri-no-cors.css".equals(path)) noCorsSriRequests.set(noCorsSriRequests.get() + 1);
                if ("/@waf/sri-network.css".equals(path) || "/@waf/sri-script-network.js".equals(path)) return null;
                if ("/@waf/sri.css".equals(path)) return sriStyle(".sri-same{color:rgb(10, 20, 30)}", null);
                if ("/@waf/sri-anon.css".equals(path)) return sriStyle(".sri-anon{color:rgb(40, 50, 60)}", java.util.Map.of("Access-Control-Allow-Origin", "https://webview.example.test"));
                if ("/@waf/sri-credentials.css".equals(path)) return sriStyle(".sri-credentials{color:rgb(70, 80, 90)}", java.util.Map.of("Access-Control-Allow-Origin", "https://webview.example.test", "Access-Control-Allow-Credentials", "true"));
                if ("/@waf/sri-bad-cors.css".equals(path)) return sriStyle(".sri-bad-cors{color:rgb(100, 110, 120)}", null);
                if ("/@waf/sri-mismatch.css".equals(path)) return sriStyle(".sri-mismatch{color:rgb(130, 140, 150)}", null);
                if ("/@waf/sri-no-cors.css".equals(path)) return sriStyle(".sri-no-cors{color:rgb(160, 170, 180)}", java.util.Map.of("Access-Control-Allow-Origin", "https://webview.example.test"));
                if ("/@waf/sri-script.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.sriSameExecuted=true;".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/sri-script-mismatch.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.sriBadExecuted=true;".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/intercepted.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.interceptedScriptLoaded=true;".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/csp-before-meta.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.cspBeforeMetaExecuted=true;".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/deferred-first.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.deferredOrder=window.deferredOrder||[];window.deferredOrder.push('first');window.deferredSawTail=!!document.getElementById('defer-tail');window.deferredReadyState=document.readyState;document.addEventListener('DOMContentLoaded',function(){window.deferredDclCallback=true})".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/deferred-second.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.deferredOrder=window.deferredOrder||[];window.deferredOrder.push('second')".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/async-first.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.asyncOneExecuted=true;window.asyncOneSawTail=!!document.getElementById('async-tail');window.asyncOneCurrentScriptSrc=document.currentScript.src".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/async-second.js".equals(path)) return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("window.asyncTwoExecuted=true;window.asyncTwoCurrentScriptSrc=document.currentScript.src".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/xhr-charset".equals(path)) return new WebResourceResponse("text/plain", "ISO-8859-1", 200, "OK", java.util.Map.of("Content-Length", "1"),
                    new ByteArrayInputStream(new byte[] {(byte) 0xe9}));
                if ("/@waf/xhr-override-charset".equals(path)) return new WebResourceResponse("text/plain", "UTF-8", 200, "OK", java.util.Map.of("Content-Length", "1"),
                    new ByteArrayInputStream(new byte[] {(byte) 0xe9}));
                if ("/@waf/xhr-arraybuffer".equals(path)) return new WebResourceResponse("application/octet-stream", null, 200, "OK", java.util.Map.of("Content-Length", "3"),
                    new ByteArrayInputStream(new byte[] {0, 0x7f, (byte) 0xff}));
                if ("/@waf/probe.css".equals(path)) return new WebResourceResponse("text/css", null, 200, "OK", null,
                    new ByteArrayInputStream(("@charset \"windows-1252\";@import url('nested.css'); @font-face{font-family:'BrokerFont';src:url('probe-font.ttf') format('truetype');font-display:block} .font-probe{font-family:'BrokerFont',serif}.css-probe{color:rgb(12, 34, 56);background-image:url('background.svg')}").getBytes(StandardCharsets.ISO_8859_1)));
                if ("/@waf/nested.css".equals(path)) return new WebResourceResponse("text/css", null, 200, "OK", null,
                    new ByteArrayInputStream(".css-probe{padding-top:7px}.css-probe::after{content:\"caf\u00e9\"}".getBytes(StandardCharsets.ISO_8859_1)));
                if ("/@waf/probe-font.ttf".equals(path)) return new WebResourceResponse("font/ttf", null, 200, "OK", null,
                    new ByteArrayInputStream(loadProbeFont()));
                if ("/@waf/cors-image.svg".equals(path)) return new WebResourceResponse("image/svg+xml", "UTF-8", 200, "OK", java.util.Map.of("Access-Control-Allow-Origin", "https://webview.example.test"),
                    new ByteArrayInputStream("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\" fill=\"#369\"/></svg>".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/background.svg".equals(path)) return new WebResourceResponse("image/svg+xml", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\" fill=\"#369\"/></svg>".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/inline-style.svg".equals(path) || "/@waf/inline-attr.svg".equals(path)) return new WebResourceResponse("image/svg+xml", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\" fill=\"#369\"/></svg>".getBytes(StandardCharsets.UTF_8)));
                if (path.endsWith("image.svg")) return new WebResourceResponse("image/svg+xml", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\" fill=\"#369\"/></svg>".getBytes(StandardCharsets.UTF_8)));
                if ("/@waf/xhr-probe".equals(path)) {
                    if (!"POST".equals(request.getMethod())) throw new AssertionError("XHR method was not preserved: " + request.getMethod());
                    return null;
                }
                String body = "local-intercept";
                return new WebResourceResponse("text/plain", "UTF-8", 200, "OK", null,
                    new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
            }
        });
        view.addJavascriptInterface(new Object() {
            @JavascriptInterface public void post(String message) { bridgeValue.set(message); bridgeDone.countDown(); }
        }, "bridge");
        try {
            String html = "<!doctype html><html><head><script src='https://blocked.example.test/@waf/csp-before-meta.js'></script><meta http-equiv='Content-Security-Policy' content=\"upgrade-insecure-requests; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.example.test; style-src 'self' https://cdn.example.test data: 'unsafe-inline'; img-src 'self' https://cdn.example.test data: blob:; font-src 'self' data:\"><link rel='stylesheet' href='https://blocked.example.test/@waf/csp-denied.css'>"
                + "<script src='https://blocked.example.test/@waf/csp-denied.js'></script><link id='probe-style' rel='stylesheet' href='probe.css'>"
                + "<link rel='stylesheet' href='sri.css' integrity='sha384-oKUSiYjKECfpI+QSaq+KWoy70hPy/o3UqzZvqjE6I6lKLx7BHoQxe6ecYCSc/HP+'>"
                + "<link rel='stylesheet' href='https://cdn.example.test/@waf/sri-anon.css' crossorigin='anonymous' integrity='sha384-CROIlAgGuqtOeQUzh0jnSQhFYJkUPz/g9MoJ2bmNZYfBt6b+QaSIuBGTdtzJN+4A'>"
                + "<link rel='stylesheet' href='https://cdn.example.test/@waf/sri-credentials.css' crossorigin='use-credentials' integrity='sha384-JXIXH2qUq/kHd55fzkJOItg8UyE8D/NEnhNTD4zIvl5LcqzzsEAkgFzp/+gm/i2a'>"
                + "<link rel='stylesheet' href='https://cdn.example.test/@waf/sri-network.css' crossorigin='anonymous' integrity='sha384-Cbnlyv4qB1PqOJX97Z+xdTgaxgDAn94hevTAKrwlgn4XsnVEvYo+w7FUaYU3qtba'>"
                + "<link rel='stylesheet' href='https://cdn.example.test/@waf/sri-bad-cors.css' crossorigin='anonymous' integrity='sha384-3aQEY1jKbpX4uFW0w2xARuopbcNEZ+VbRmZ453Fdsrt+DWPYqDh0thn1vhlnDgIP'>"
                + "<link rel='stylesheet' href='sri-mismatch.css' integrity='sha384-invalid'>"
                + "<link rel='stylesheet' href='https://cdn.example.test/@waf/sri-no-cors.css' integrity='sha384-r0iqqB7jWlaCuBJYaS2hCS4/bGBiAXwrLyNyQAWdjfvSmMdY72/OYVBw8HwAXgEh'>"
                + "<script src='sri-script.js' integrity='sha384-87dK5tLN7HvtbJLnEebKPUy9hbrkLvt97J1z51i85RDd/31z7f6tVNIwOUsyCkPv'></script>"
                + "<script src='sri-script-mismatch.js' integrity='sha384-invalid'></script>"
                + "<script src='https://cdn.example.test/@waf/sri-script-network.js' crossorigin='anonymous' integrity='sha384-RXuWiomJro0wSbGBjGbIHrpt1xJnxvK6oHSDTcSAqJRScf9Ij8TLQZR9yaGQs9wF'></script>"
                + "<meta http-equiv='Content-Security-Policy' content=\"script-src 'self' 'nonce-probe' 'unsafe-eval' https://cdn.example.test\"><script>window.unauthorizedInlineExecuted=true</script>"
                + "<script defer src='deferred-first.js'></script><script defer src='deferred-second.js'></script>"
                + "<script async defer src='async-first.js'></script><script nonce='probe'>window.asyncParserContinued=!window.asyncOneExecuted</script><script async src='async-second.js'></script>"
                + "<style>#inline-css-probe{background-image:url('inline-style.svg');padding-left:9px}</style></head><body>"
                + "<div id='css-probe' class='css-probe'></div>"
                + "<div class='sri-same'></div><div class='sri-anon'></div><div class='sri-credentials'></div><div class='sri-network'></div><div class='sri-bad-cors'></div><div class='sri-mismatch'></div><div class='sri-no-cors'></div>"
                + "<span id='font-probe' class='font-probe'>iiii</span>"
                + "<div id='inline-css-probe'></div><div id='inline-attr-probe' style=\"background-image:url('inline-attr.svg');padding-right:11px\"></div>"
                + "<img id='static-image' src='static-image.svg' width='1' height='1'>"
                + "<img id='csp-upgrade-image' src='http://webview.example.test/@waf/csp-upgrade-image.svg' width='1' height='1'>"
                + "<img id='csp-upgrade-dynamic-image' width='1' height='1'>"
                + "<img id='cross-origin-image' src='https://cdn.example.test/@waf/cross-origin-image.svg' width='1' height='1'>"
                + "<img id='cors-image' crossorigin='anonymous' src='https://cdn.example.test/@waf/cors-image.svg' width='1' height='1'>"
                + "<img id='srcset-image' srcset='srcset-image.svg 1x' width='1' height='1'>"
                + "<picture><source srcset='picture-image.svg 1x'><img id='picture-image' src='picture-fallback.svg' width='1' height='1'></picture>"
                + "<div id='defer-tail'></div><div id='async-tail'></div><script nonce='probe'>document.addEventListener('DOMContentLoaded',function(){window.sourceDclSawDeferred=!!window.deferredSawTail&&window.deferredOrder&&window.deferredOrder.join(',')==='first,second';window.asyncAtDcl=!!window.asyncOneExecuted||!!window.asyncTwoExecuted});window.addEventListener('load',function(){window.asyncAtLoad=!!window.asyncOneExecuted&&!!window.asyncTwoExecuted})</script>"
                + "<script src='intercepted.js'></script><script nonce='probe'>"
                + "const strictPolicy=Array.from(document.querySelectorAll('meta[http-equiv]')).map(meta=>meta.content).find(content=>content.includes(\"script-src 'self' 'nonce-probe'\"));if(window.unauthorizedInlineExecuted||!strictPolicy||!/'sha256-[^']+'/.test(strictPolicy))throw new Error('strict source CSP or generated-script hash check failed');"
                + "if(!window.interceptedScriptLoaded||!window.sriSameExecuted||!window.sriNetworkExecuted||!window.cspBeforeMetaExecuted||window.sriBadExecuted){bridge.post('static-script-failed')}else{"
                + "const ready=image=>new Promise((resolve,reject)=>{const result=()=>({id:image.id||image.currentSrc,width:image.naturalWidth,height:image.naturalHeight,ok:image.naturalWidth===1});image.onload=()=>resolve(result());image.onerror=()=>reject(new Error('image failed: '+(image.id||image.currentSrc)));if(image.complete&&image.naturalWidth)resolve(result())});"
                + "const staticImage=document.getElementById('static-image'),upgradedImage=document.getElementById('csp-upgrade-image'),upgradedDynamicImage=document.getElementById('csp-upgrade-dynamic-image'),crossOriginImage=document.getElementById('cross-origin-image'),corsImage=document.getElementById('cors-image'),dynamicImage=new Image(),srcsetImage=document.getElementById('srcset-image'),pictureImage=document.getElementById('picture-image'),dynamicSrcsetImage=new Image();"
                + "dynamicSrcsetImage.id='dynamic-srcset-image';document.body.append(dynamicSrcsetImage);"
                + "const staticReady=ready(staticImage),upgradedReady=ready(upgradedImage),upgradedDynamicReady=ready(upgradedDynamicImage),crossOriginReady=ready(crossOriginImage),corsReady=ready(corsImage),dynamicReady=ready(dynamicImage),srcsetReady=ready(srcsetImage),pictureReady=ready(pictureImage),dynamicSrcsetReady=ready(dynamicSrcsetImage);"
                + "const upgradedFetchReady=fetch('http://webview.example.test/@waf/csp-upgrade-fetch').then(async response=>{if(await response.text()!=='upgrade-ok')throw new Error('upgrade-insecure-requests fetch failed');return true});"
                + "const deferredReady=new Promise((resolve,reject)=>document.addEventListener('DOMContentLoaded',()=>{const state={readyState:document.readyState,source:window.sourceDclSawDeferred,deferredState:window.deferredReadyState,order:window.deferredOrder};if(state.readyState==='interactive'&&state.source===true&&state.deferredState==='interactive'&&state.order&&state.order.join(',')==='first,second')resolve(true);else reject(new Error('deferred script semantics mismatch: '+JSON.stringify(state)))},{once:true}));"
                + "const asyncReady=Promise.all(window.__suwayomiAsyncScriptPromises);"
                + "dynamicImage.src='dynamic-image.svg';upgradedDynamicImage.src='http://webview.example.test/@waf/csp-upgrade-dynamic-image.svg';dynamicSrcsetImage.srcset='dynamic-srcset-image.svg 1x';"
                + "const readiness={staticImage:staticReady,upgradedImage:upgradedReady,upgradedDynamicImage:upgradedDynamicReady,crossOriginImage:crossOriginReady,corsImage:corsReady,dynamicImage:dynamicReady,srcsetImage:srcsetReady,pictureImage:pictureReady,dynamicSrcsetImage:dynamicSrcsetReady,upgradedFetch:upgradedFetchReady,deferredScripts:deferredReady,asyncScripts:asyncReady};"
                + "Promise.all(Object.entries(readiness).map(([name,check])=>check.then(value=>({name,value}),error=>({name,error:String(error)})))).then(results=>{"
                + "const failed=results.filter(result=>result.error||!(result.value===true||result.value?.ok===true||Array.isArray(result.value)&&result.value.every(value=>value===true)));if(failed.length)throw new Error('readiness checks failed: '+JSON.stringify(failed));"
                + "if(!window.asyncParserContinued||!window.asyncOneExecuted||!window.asyncTwoExecuted||window.asyncAtLoad!==true||window.asyncOneCurrentScriptSrc!=='https://webview.example.test/@waf/async-first.js'||window.asyncTwoCurrentScriptSrc!=='https://webview.example.test/@waf/async-second.js')throw new Error('async script semantics mismatch: '+JSON.stringify({parserContinued:window.asyncParserContinued,first:window.asyncOneExecuted,second:window.asyncTwoExecuted,firstSrc:window.asyncOneCurrentScriptSrc,secondSrc:window.asyncTwoCurrentScriptSrc,atDcl:window.asyncAtDcl,atLoad:window.asyncAtLoad}));"
                + "if(!srcsetImage.currentSrc.endsWith('/@waf/srcset-image.svg')||!pictureImage.currentSrc.endsWith('/@waf/picture-image.svg')||!dynamicSrcsetImage.currentSrc.endsWith('/@waf/dynamic-srcset-image.svg'))throw new Error('responsive image candidate was not selected');"
                + "const css=getComputedStyle(document.getElementById('css-probe')),inlineCss=getComputedStyle(document.getElementById('inline-css-probe')),inlineAttr=getComputedStyle(document.getElementById('inline-attr-probe')),sri=document.querySelector('.sri-same'),encodedContent=getComputedStyle(document.getElementById('css-probe'),'::after').content;if(css.color!=='rgb(12, 34, 56)'||css.paddingTop!=='7px'||encodedContent.length!==6||encodedContent.charCodeAt(4)!==233||!css.backgroundImage.startsWith('url(\"data:image/svg+xml;base64,')||inlineCss.paddingLeft!=='9px'||!inlineCss.backgroundImage.startsWith('url(\"data:image/svg+xml;base64,')||inlineAttr.paddingRight!=='11px'||!inlineAttr.backgroundImage.startsWith('url(\"data:image/svg+xml;base64,')||getComputedStyle(sri).color!=='rgb(10, 20, 30)'||getComputedStyle(document.querySelector('.sri-anon')).color!=='rgb(40, 50, 60)'||getComputedStyle(document.querySelector('.sri-credentials')).color!=='rgb(70, 80, 90)'||getComputedStyle(document.querySelector('.sri-network')).color!=='rgb(190, 200, 210)'||getComputedStyle(document.querySelector('.sri-bad-cors')).color==='rgb(100, 110, 120)'||getComputedStyle(document.querySelector('.sri-mismatch')).color==='rgb(130, 140, 150)'||getComputedStyle(document.querySelector('.sri-no-cors')).color==='rgb(160, 170, 180)')throw new Error('brokered CSS/SRI resources or encoding mismatch: '+css.color+':'+css.paddingTop+':'+encodedContent+':'+inlineCss.paddingLeft+':'+inlineAttr.paddingRight);"
                + "return document.fonts.load('16px BrokerFont','iiii').then(async fontFaces=>{const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font='16px BrokerFont';const fontWidth=context.measureText('iiii').width;context.font='16px serif';const fallbackWidth=context.measureText('iiii').width;if(!fontFaces.length||fontFaces.some(face=>face.status!=='loaded')||fontWidth<=fallbackWidth*1.5)throw new Error('brokered font failed to decode/render: faces='+fontFaces.length+',width='+fontWidth+',fallback='+fallbackWidth);const cleanCanvas=document.createElement('canvas'),cleanContext=cleanCanvas.getContext('2d');cleanContext.drawImage(staticImage,0,0);if(cleanContext.getImageData(0,0,1,1).data[3]!==255)throw new Error('same-origin image incorrectly tainted its canvas');const corsCanvas=document.createElement('canvas'),corsContext=corsCanvas.getContext('2d');corsContext.drawImage(corsImage,0,0);if(corsContext.getImageData(0,0,1,1).data[3]!==255)throw new Error('CORS-approved image incorrectly tainted its canvas');const taintedCanvas=document.createElement('canvas'),taintedContext=taintedCanvas.getContext('2d');taintedContext.drawImage(crossOriginImage,0,0);const denied=action=>{try{action();return false}catch(e){return e.name==='SecurityError'}};if(!denied(()=>taintedContext.getImageData(0,0,1,1))||!denied(()=>taintedCanvas.toDataURL())||!denied(()=>taintedCanvas.toBlob(()=>{})))throw new Error('cross-origin image pixels were readable');const propagated=document.createElement('canvas'),propagatedContext=propagated.getContext('2d');propagatedContext.drawImage(taintedCanvas,0,0);if(!denied(()=>propagatedContext.getImageData(0,0,1,1)))throw new Error('canvas taint did not propagate through drawImage');const bitmapDenied=await createImageBitmap(crossOriginImage).then(()=>false,e=>e.name==='SecurityError');if(!bitmapDenied)throw new Error('createImageBitmap exposed cross-origin pixels');taintedCanvas.width=1;if(taintedContext.getImageData(0,0,1,1).data[3]!==0)throw new Error('canvas resize did not reset origin-clean state');return fetch('probe').then(r=>r.text()).then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST','xhr-probe');x.responseType='json';x.onload=()=>resolve(v+':'+x.response.state+':'+x.status);x.onerror=()=>reject(new Error('XHR failed'));x.send('probe-body')}))})"
                + "}).then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();let progress=false;x.open('GET','xhr-charset');x.responseType='text';x.onprogress=e=>{progress=e.loaded===1&&e.total===1&&e.lengthComputable};x.onload=()=>{try{if(x.responseText!=='é'||x.response!=='é'||!progress)throw new Error('XHR charset/progress mismatch');resolve(v+':charset-progress')}catch(e){reject(e)}};x.onerror=()=>reject(new Error('charset XHR failed'));x.send()}))"
                + ".then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','xhr-override-charset');x.overrideMimeType('text/plain; charset=ISO-8859-1');x.onload=()=>{if(x.responseText==='é')resolve(v+':override-charset');else reject(new Error('XHR overrideMimeType charset mismatch'))};x.onerror=()=>reject(new Error('overrideMimeType XHR failed'));x.send()}))"
                + ".then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','xhr-arraybuffer');x.responseType='arraybuffer';x.onload=()=>{try{const b=new Uint8Array(x.response);let textError=false;try{x.responseText}catch(e){textError=e.name==='InvalidStateError'}if(b.length!==3||b[0]!==0||b[1]!==127||b[2]!==255||!textError)throw new Error('XHR arraybuffer mismatch');resolve(v+':arraybuffer')}catch(e){reject(e)}};x.onerror=()=>reject(new Error('arraybuffer XHR failed'));x.send()}))"
                + ".then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest(),progress=[];x.open('GET','xhr-stream');x.responseType='text';x.onprogress=e=>progress.push({loaded:e.loaded,total:e.total,lengthComputable:e.lengthComputable,text:x.responseText});x.onload=()=>{try{if(x.responseText!=='abc'||progress.length!==3||progress.map(e=>e.loaded).join(',')!=='1,2,3'||progress.some(e=>!e.lengthComputable||e.total!==3)||progress.map(e=>e.text).join(',')!=='a,ab,abc')throw new Error('XHR stream was buffered: '+JSON.stringify(progress));resolve(v+':stream-progress')}catch(e){reject(e)}};x.onerror=()=>reject(new Error('streaming XHR failed: status='+x.status+',state='+x.readyState+',headers='+x.getAllResponseHeaders()));x.send()}))"
                + ".then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();let timedOut=false,loaded=false;x.open('GET','xhr-timeout');x.timeout=100;x.ontimeout=()=>{timedOut=true};x.onload=()=>{loaded=true};x.onloadend=()=>{if(!timedOut||loaded||x.status!==0||x.readyState!==XMLHttpRequest.DONE)reject(new Error('XHR timeout semantics mismatch: timedOut='+timedOut+',loaded='+loaded+',status='+x.status+',readyState='+x.readyState));else resolve(v+':timeout')};x.onerror=()=>reject(new Error('timeout request errored'));x.send()}))"
                + ".then(v=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();let aborted=false,loaded=false,errored=false;x.open('GET','xhr-abort');x.onabort=()=>{aborted=true};x.onload=()=>{loaded=true};x.onerror=()=>{errored=true};x.onloadend=()=>setTimeout(()=>{if(!aborted||loaded||errored||x.status!==0||x.readyState!==XMLHttpRequest.UNSENT)reject(new Error('XHR abort emitted stale completion'));else resolve(v+':abort')},2500);x.send();setTimeout(()=>x.abort(),0)}))"
                + ".then(v=>Promise.all([fetch('https://blocked.example.test/@waf/csp-denied-fetch').then(()=>{throw new Error('connect-src CSP was bypassed')},e=>{if(!/Content Security Policy/.test(e.message))throw e;return true}),new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>reject(new Error('img-src CSP was bypassed'));image.onerror=()=>resolve(true);image.src='https://blocked.example.test/@waf/csp-denied-image'})]).then(()=>v+':csp-connect-blocked:csp-image-blocked'))"
                + ".then(v=>bridge.post(v+':stylesheets-brokered:imports-brokered:css-charset-inherited:font-url-brokered:font-decoded-rendered:css-image-brokered:inline-style-brokered:inline-attr-brokered:images-brokered:srcset-brokered:picture-brokered:dynamic-srcset-brokered:canvas-taint-readback-blocked:canvas-taint-propagated:canvas-reset:canvas-cors-approved')).catch(e=>bridge.post('fetch-error:'+e.message))}</script></body></html>";
            view.loadDataWithBaseURL("https://webview.example.test/@waf/solver", html, "text/html", "UTF-8", null);
            if (!pageDone.await(10, TimeUnit.SECONDS)) throw new AssertionError("Browser WebView page-finished event timed out");
            if (!bridgeDone.await(10, TimeUnit.SECONDS)) throw new AssertionError("Browser WebView JS bridge timed out" + (webViewError.get() == null ? "" : ": " + webViewError.get()));
            if (!"local-intercept:xhr-brokered:200:charset-progress:override-charset:arraybuffer:stream-progress:timeout:abort:csp-connect-blocked:csp-image-blocked:stylesheets-brokered:imports-brokered:css-charset-inherited:font-url-brokered:font-decoded-rendered:css-image-brokered:inline-style-brokered:inline-attr-brokered:images-brokered:srcset-brokered:picture-brokered:dynamic-srcset-brokered:canvas-taint-readback-blocked:canvas-taint-propagated:canvas-reset:canvas-cors-approved".equals(bridgeValue.get()) || intercepted.get() != 36 || !"https://webview.example.test/@waf/csp-upgrade-image.svg".equals(upgradedImageUrl.get()) || !"https://webview.example.test/@waf/csp-upgrade-dynamic-image.svg".equals(upgradedDynamicImageUrl.get()) || !"https://webview.example.test/@waf/csp-upgrade-fetch".equals(upgradedFetchUrl.get()) || noCorsSriRequests.get() != 0 || !String.valueOf(sameOriginSriCookie.get()).contains("wv_sri_same=1") || !"null|https://webview.example.test".equals(anonymousSriHeaders.get()) || !String.valueOf(credentialedSriHeaders.get()).contains("wv_sri_cdn=1|https://webview.example.test") || !"null|https://webview.example.test".equals(networkSriHeaders.get()) || !"null|https://webview.example.test".equals(networkSriScriptHeaders.get())) throw new AssertionError("WebViewClient resource/XHR/SRI interception failed: body=" + bridgeValue.get() + ", callbacks=" + intercepted.get() + ", upgraded-image=" + upgradedImageUrl.get() + ", upgraded-dynamic-image=" + upgradedDynamicImageUrl.get() + ", upgraded-fetch=" + upgradedFetchUrl.get() + ", same-origin=" + sameOriginSriCookie.get() + ", anonymous=" + anonymousSriHeaders.get() + ", credentials=" + credentialedSriHeaders.get() + ", network=" + networkSriHeaders.get() + ", script=" + networkSriScriptHeaders.get() + ", no-cors=" + noCorsSriRequests.get());
            view.evaluateJavascript("1 + 1", new ValueCallback<String>() {
                @Override public void onReceiveValue(String value) { evaluation.set(value); evaluated.countDown(); }
            });
            if (!evaluated.await(10, TimeUnit.SECONDS) || !"2".equals(evaluation.get())) throw new AssertionError("Browser WebView JavaScript evaluation failed: " + evaluation.get());
            return "Browser WebView bridge: sandboxed HTML, source-CSP enforcement for brokered scripts/stylesheets/fetch/XHR/images and redirects, ordered classic defer execution at interactive state before DOMContentLoaded, asynchronous classic scripts execute without parser blocking and retain original currentScript URLs, upgrade-insecure-requests before static/dynamic image and fetch dispatch, brokered external/inline stylesheets and imports, same-origin/cross-origin stylesheet and script SRI SHA-384 verification through intercepted and streamed network paths, strongest-hash mismatch rejection, anonymous/use-credentials CORS checks and cookie isolation, inherited Windows-1252 @charset decoding, valid TTF decoding/rendering, CSS images, same-origin/CORS/cross-origin canvas readback and taint propagation/reset, static-script and static/dynamic/srcset/picture images, fetch/XHR decoding/progressive stream/timeout/abort with in-flight cancellation, page-finished callback, JS bridge, evaluation and teardown verified";
        } finally {
            view.destroy();
            WebViewCookieStoreProbe.restore(previousCookieStore);
        }
    }

    /** Verifies Android's initial-main-frame interception callback through the browser host. */
    public static String verifyLoadUrl(String url) throws Exception {
        CountDownLatch pageDone = new CountDownLatch(1);
        CountDownLatch interceptedScriptDone = new CountDownLatch(1);
        CountDownLatch evaluated = new CountDownLatch(1);
        CountDownLatch statementEvaluated = new CountDownLatch(1);
        CountDownLatch statementRead = new CountDownLatch(1);
        AtomicReference<Boolean> mainFrameRequested = new AtomicReference<>(false);
        AtomicReference<Boolean> syntheticDocument = new AtomicReference<>(false);
        AtomicReference<Boolean> interceptedScriptRan = new AtomicReference<>(false);
        AtomicReference<String> evaluation = new AtomicReference<>();
        AtomicReference<String> statementValue = new AtomicReference<>();
        AtomicReference<String> statementReadValue = new AtomicReference<>();
        AtomicReference<String> webViewError = new AtomicReference<>();
        boolean syntheticInline = url.contains("synthetic=allow");
        boolean syntheticNonce = url.contains("synthetic=nonce");
        boolean syntheticBlob = url.contains("synthetic=blob");
        boolean intercept = syntheticInline || syntheticNonce || syntheticBlob || url.contains("synthetic=deny");
        boolean expectedScript = syntheticInline || syntheticNonce;
        boolean expectedEvaluation = expectedScript || syntheticBlob;
        WebView view = new WebView(new Context());
        view.setWebViewClient(new android.webkit.WebViewClient() {
            @Override public void onPageFinished(WebView ignored, String finishedUrl) {
                if (!url.equals(finishedUrl)) webViewError.set("Unexpected finished URL: " + finishedUrl);
                if (intercept && expectedEvaluation) view.evaluateJavascript("1 + 1", new ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) { evaluation.set(value); evaluated.countDown(); }
                });
                pageDone.countDown();
            }
            @Override public void onReceivedError(WebView ignored, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                webViewError.set(String.valueOf(error == null ? null : error.getDescription()));
                pageDone.countDown();
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, android.webkit.WebResourceRequest request) {
                if (!request.isForMainFrame()) return null;
                if (!url.equals(request.getUrl().toString())) throw new AssertionError("Main-frame callback URL changed: " + request.getUrl());
                if (!"GET".equals(request.getMethod()) || request.isRedirect()) throw new AssertionError("Unexpected initial main-frame request metadata");
                if (request.getRequestHeaders().get("User-Agent") == null) throw new AssertionError("Main-frame callback omitted the WebView user agent");
                mainFrameRequested.set(true);
                if (!intercept) return null;
                syntheticDocument.set(true);
                String policy = syntheticInline ? "default-src 'none'; script-src 'unsafe-inline'" : syntheticNonce
                    ? "default-src 'none'; script-src 'nonce-probe'" : syntheticBlob
                    ? "default-src 'none'; script-src blob:" : "default-src 'none'; script-src 'none'";
                String nonce = syntheticNonce ? " nonce='probe'" : "";
                String html = "<!doctype html><html><head><title>Intercepted main frame</title></head><body><script" + nonce + ">window.bridge.post('main-frame-script-ran')</script></body></html>";
                return new WebResourceResponse("text/html", "UTF-8", 200, "OK",
                    java.util.Map.of("Content-Security-Policy", policy),
                    new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
            }
        });
        view.addJavascriptInterface(new Object() {
            @JavascriptInterface public void post(String message) {
                if (!"main-frame-script-ran".equals(message)) webViewError.set("Unexpected intercepted-page bridge payload: " + message);
                else interceptedScriptRan.set(true);
                interceptedScriptDone.countDown();
            }
        }, "bridge");
        try {
            view.loadUrl(url);
            if (!pageDone.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Browser main-frame WebView load timed out");
            if (webViewError.get() != null) throw new IllegalStateException(webViewError.get());
            if (!mainFrameRequested.get()) throw new AssertionError("shouldInterceptRequest did not receive the initial main-frame request");
            if (syntheticDocument.get()) {
                interceptedScriptDone.await(1, TimeUnit.SECONDS);
                boolean scriptRan = interceptedScriptRan.get();
                if (scriptRan != expectedScript) throw new AssertionError("Intercepted response-header CSP was not enforced: expected script=" + expectedScript + ", got " + scriptRan);
                if (expectedEvaluation) {
                    if (!evaluated.await(5, TimeUnit.SECONDS) || !"2".equals(evaluation.get()))
                        throw new AssertionError("WebView evaluation failed under a CSP-authorized execution path: " + evaluation.get());
                    view.evaluateJavascript("window.__evalStatement = 7; window.__evalStatement", new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) { statementValue.set(value); statementEvaluated.countDown(); }
                    });
                    if (!statementEvaluated.await(5, TimeUnit.SECONDS)) throw new AssertionError("WebView statement evaluation did not finish");
                    view.evaluateJavascript("window.__evalStatement", new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) { statementReadValue.set(value); statementRead.countDown(); }
                    });
                    if (!statementRead.await(5, TimeUnit.SECONDS) || !"7".equals(statementReadValue.get()))
                        throw new AssertionError("WebView statement evaluation did not mutate page state: " + statementValue.get() + ", " + statementReadValue.get());
                }
            }
            return syntheticDocument.get()
                ? "Main-frame interception and response-header CSP verified"
                : "Initial main-frame callback verified; native browser navigation completed";
        } finally { view.destroy(); }
    }

    private static WebResourceResponse sriStyle(String css, java.util.Map<String, String> headers) {
        return new WebResourceResponse("text/css", "UTF-8", 200, "OK", headers,
            new ByteArrayInputStream(css.getBytes(StandardCharsets.UTF_8)));
    }
}
