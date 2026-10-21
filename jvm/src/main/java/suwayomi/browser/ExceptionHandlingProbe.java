package suwayomi.browser;

import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;

public final class ExceptionHandlingProbe {
    public static String run() throws Exception {
        // Resolve the harness's own catch type first, not the fixture's.
        InvocationTargetException.class.getName();
        StringBuilder result = new StringBuilder();
        for (String method : new String[]{"throwable", "exception", "runtime", "exact", "nativeThrow", "nested", "inlineCatch"}) {
            String name = "suwayomi.browser." + (method.equals("inlineCatch") ? "KotlinExceptionCatchFixture" : "ExceptionCatchFixture");
            byte[] bytes;
            try (InputStream input = ExceptionHandlingProbe.class.getResourceAsStream("/" + name.replace('.', '/') + ".class")) {
                bytes = input.readAllBytes();
            }
            ClassLoader loader = new ClassLoader(ExceptionHandlingProbe.class.getClassLoader()) {
                @Override protected Class<?> loadClass(String requested, boolean resolve) throws ClassNotFoundException {
                    if (requested.equals("java.lang.Throwable") || requested.equals("java.lang.Exception")) System.gc();
                    if (!requested.equals(name)) return super.loadClass(requested, resolve);
                    Class<?> found = findLoadedClass(requested);
                    if (found == null) found = defineClass(requested, bytes, 0, bytes.length);
                    if (resolve) resolveClass(found);
                    return found;
                }
            };
            if (result.length() > 0) result.append(';');
            result.append(method).append('=');
            try { result.append(Class.forName(name, true, loader).getMethod(method).invoke(null)); }
            catch (InvocationTargetException error) { result.append("ESCAPED:").append(error.getCause().getClass().getName()); }
        }
        return result.toString();
    }
    public static void main(String[] args) throws Exception { System.out.println(run()); }
}
