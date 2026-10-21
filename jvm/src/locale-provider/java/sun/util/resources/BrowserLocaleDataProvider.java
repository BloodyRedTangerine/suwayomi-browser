package sun.util.resources;

import java.util.Locale;
import java.util.ResourceBundle;

/** Class-path bridge for CLDR bundles in jdk.localedata on the browser JVM. */
public final class BrowserLocaleDataProvider extends LocaleData.CommonResourceBundleProvider {
    @Override
    public ResourceBundle getBundle(String baseName, Locale locale) {
        String bundleName = toBundleName(baseName, locale);
        ResourceBundle bundle = load(bundleName);
        if (bundle == null) {
            String otherBundleName = toOtherBundleName(baseName, bundleName, locale);
            if (!bundleName.equals(otherBundleName)) bundle = load(otherBundleName);
        }
        return bundle;
    }

    @SuppressWarnings({"unchecked", "deprecation"})
    private static ResourceBundle load(String bundleName) {
        try {
            Class<?> type = Class.forName(bundleName);
            if (!ResourceBundle.class.isAssignableFrom(type)) return null;
            return ((Class<? extends ResourceBundle>) type).newInstance();
        } catch (ClassNotFoundException missing) {
            return null;
        } catch (ReflectiveOperationException error) {
            throw new InternalError(error);
        }
    }
}
