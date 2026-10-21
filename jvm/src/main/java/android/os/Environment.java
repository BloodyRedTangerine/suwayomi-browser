package android.os;
import java.io.File;
/** Storage paths are inside the browser VM, never the host filesystem. */
public final class Environment {
    public static File getExternalStorageDirectory() { return new File("/data"); }
    public static File getLegacyExternalStorageDirectory() { return new File("/data"); }
    public static boolean isExternalStorageEmulated() { return true; }
}
