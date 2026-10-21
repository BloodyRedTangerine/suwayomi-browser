package suwayomi.browser;

import java.net.URLClassLoader;
import java.net.MalformedURLException;
import java.io.File;

/** Resource-only loader for libraries placed on the WASM VM's bootstrap classpath. */
public final class BrowserResources {
    private static ClassLoader resources;
    public static synchronized ClassLoader loader(Class<?> owner) {
        ClassLoader actual = owner.getClassLoader();
        if (actual != null) return actual;
        if (resources == null) {
            try {
                resources = new URLClassLoader(new java.net.URL[]{new File("/extensions/host.jar").toURI().toURL()}, null);
            } catch (MalformedURLException error) { throw new IllegalStateException(error); }
        }
        return resources;
    }
}
