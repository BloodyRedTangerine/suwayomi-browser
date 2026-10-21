package android.widget;

import android.content.Context;
import android.text.Editable;
import android.text.SpannableStringBuilder;
import android.text.TextWatcher;
import android.view.View;
import java.util.ArrayList;
import java.util.List;

/** In-memory text control state; the browser frontend owns any visible rendering. */
public class TextView extends View {
    private Editable text = new SpannableStringBuilder();
    private CharSequence error;
    private CharSequence hint;
    private int textColor = 0xff000000;
    private int inputType;
    private int selectionStart;
    private int selectionEnd;
    private boolean horizontallyScrolling;
    private final List<TextWatcher> watchers = new ArrayList<>();

    public TextView(Context context) { super(context); }
    public TextView(Context context, android.util.AttributeSet attributes) { this(context); }
    public CharSequence getText() { return text; }
    public void setText(CharSequence value) {
        String next = value == null ? "" : value.toString();
        Editable previous = text;
        for (TextWatcher watcher : List.copyOf(watchers)) watcher.beforeTextChanged(previous, 0, previous.length(), next.length());
        text = new SpannableStringBuilder(next);
        selectionStart = selectionEnd = text.length();
        for (TextWatcher watcher : List.copyOf(watchers)) watcher.onTextChanged(text, 0, previous.length(), text.length());
        for (TextWatcher watcher : List.copyOf(watchers)) watcher.afterTextChanged(text);
    }
    public void setText(int resourceId) { setText(getContext().getString(resourceId)); }
    public void append(CharSequence value) { setText(text.toString() + (value == null ? "" : value)); }
    public void addTextChangedListener(TextWatcher watcher) { if (watcher != null && !watchers.contains(watcher)) watchers.add(watcher); }
    public void removeTextChangedListener(TextWatcher watcher) { watchers.remove(watcher); }
    public void setError(CharSequence error) { this.error = error; }
    public CharSequence getError() { return error; }
    public void setHint(CharSequence hint) { this.hint = hint; }
    public void setHint(int resourceId) { setHint(getContext().getString(resourceId)); }
    public CharSequence getHint() { return hint; }
    public void setInputType(int value) { inputType = value; }
    public int getInputType() { return inputType; }
    public void setHorizontallyScrolling(boolean value) { horizontallyScrolling = value; }
    public boolean getHorizontallyScrolling() { return horizontallyScrolling; }
    public void selectAll() { setSelection(0, text.length()); }
    public void setSelection(int index) { setSelection(index, index); }
    public void setSelection(int start, int end) {
        if (start < 0 || end < start || end > text.length()) throw new IndexOutOfBoundsException("Text selection outside content");
        selectionStart = start; selectionEnd = end;
    }
    public int getSelectionStart() { return selectionStart; }
    public int getSelectionEnd() { return selectionEnd; }
    public void setTextColor(int color) { textColor = color; }
    public int getCurrentTextColor() { return textColor; }
}
