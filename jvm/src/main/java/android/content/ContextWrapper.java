package android.content;
import java.io.File;

/** Android context delegation used by compiled extension preference helpers. */
public class ContextWrapper extends Context {
    private Context base;
    public ContextWrapper(Context base) { this.base = base; }
    protected void attachBaseContext(Context base) { this.base = base; }
    public Context getBaseContext() { return base == null ? this : base; }
    @Override public SharedPreferences getSharedPreferences(String name, int mode) { return base == null ? super.getSharedPreferences(name, mode) : base.getSharedPreferences(name, mode); }
    @Override public File getCacheDir() { return base == null ? super.getCacheDir() : base.getCacheDir(); }
    @Override public File getFilesDir() { return base == null ? super.getFilesDir() : base.getFilesDir(); }
    @Override public String getPackageName() { return base == null ? super.getPackageName() : base.getPackageName(); }
    @Override public void startActivity(Intent intent) { if (base == null) super.startActivity(intent); else base.startActivity(intent); }
}
