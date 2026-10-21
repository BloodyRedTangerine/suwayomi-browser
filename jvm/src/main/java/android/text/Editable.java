package android.text;

/** Mutable text value exposed by Android text controls. */
public interface Editable extends CharSequence {
    Editable replace(int start, int end, CharSequence value);
    Editable append(CharSequence value);
    Editable delete(int start, int end);
}
