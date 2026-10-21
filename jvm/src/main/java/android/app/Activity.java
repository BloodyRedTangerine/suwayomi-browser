package android.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.ContextThemeWrapper;

/** Lifecycle shell for extension code; visible screens are owned by the browser frontend. */
public class Activity extends ContextThemeWrapper {
    private Intent intent = new Intent();
    private boolean finishing;
    private int resultCode;
    private Intent resultData;

    public Activity() { super(new Context(), 0); }
    public Intent getIntent() { return intent; }
    public void setIntent(Intent intent) { this.intent = intent == null ? new Intent() : new Intent(intent); }
    public void onCreate(Bundle savedInstanceState) {}
    public void finish() { finishing = true; }
    public boolean isFinishing() { return finishing; }
    public void setResult(int resultCode) { setResult(resultCode, null); }
    public void setResult(int resultCode, Intent data) { this.resultCode = resultCode; resultData = data == null ? null : new Intent(data); }
    public int getResultCode() { return resultCode; }
    public Intent getResultData() { return resultData == null ? null : new Intent(resultData); }
}
