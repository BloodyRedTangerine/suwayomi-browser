package android.icu.text;

/** Common Android ICU search surface backed by the corresponding ICU4J iterator. */
public abstract class SearchIterator {
    final com.ibm.icu.text.SearchIterator delegate;

    SearchIterator(com.ibm.icu.text.SearchIterator delegate) { this.delegate = delegate; }

    public int first() { return delegate.first(); }
    public int next() { return delegate.next(); }
    public String getMatchedText() { return delegate.getMatchedText(); }
    public void setOverlapping(boolean value) { delegate.setOverlapping(value); }
}
