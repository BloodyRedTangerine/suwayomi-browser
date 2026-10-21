package android.icu.text;

/** Android ICU compatibility surface backed by the bundled pure-Java ICU4J engine. */
public abstract class Collator implements java.util.Comparator<Object> {
    public static final int PRIMARY = 0;
    public static final int SECONDARY = 1;
    public static final int TERTIARY = 2;
    public static final int QUATERNARY = 3;
    public static final int IDENTICAL = 15;
    public static final int NO_DECOMPOSITION = 16;
    public static final int CANONICAL_DECOMPOSITION = 17;
    public static final int FULL_DECOMPOSITION = 18;

    final com.ibm.icu.text.Collator delegate;

    Collator(com.ibm.icu.text.Collator delegate) {
        this.delegate = java.util.Objects.requireNonNull(delegate, "delegate");
    }

    public static Collator getInstance() {
        com.ibm.icu.text.Collator value = com.ibm.icu.text.Collator.getInstance();
        if (value instanceof com.ibm.icu.text.RuleBasedCollator ruleBased)
            return new RuleBasedCollator(ruleBased);
        throw new IllegalStateException("ICU4J returned an unsupported collator implementation");
    }

    public int compare(String left, String right) { return delegate.compare(left, right); }
    @Override public int compare(Object left, Object right) { return delegate.compare(left, right); }
    public void setStrength(int value) { delegate.setStrength(value); }
    public int getStrength() { return delegate.getStrength(); }
    public void setDecomposition(int value) { delegate.setDecomposition(value); }
    public int getDecomposition() { return delegate.getDecomposition(); }
}
