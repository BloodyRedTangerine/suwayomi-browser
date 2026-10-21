package android.widget;
import android.content.Context;
import android.text.Editable;
/** Preference input state; actual input controls are rendered by the browser UI. */
public class EditText extends TextView {
    private boolean singleLine;
    public EditText(Context context) { super(context); }
    public void setSingleLine(boolean value) { singleLine = value; }
    public void setSingleLine() { singleLine = true; }
    public boolean isSingleLine() { return singleLine; }
    @Override public Editable getText() { return (Editable)super.getText(); }
}
