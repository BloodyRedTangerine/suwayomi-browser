package android.icu.text;

/** Android RuleBasedCollator facade; all collation behavior comes from ICU4J. */
public final class RuleBasedCollator extends Collator {
    RuleBasedCollator(com.ibm.icu.text.RuleBasedCollator delegate) { super(delegate); }

    public RuleBasedCollator(String rules) throws Exception {
        super(new com.ibm.icu.text.RuleBasedCollator(rules));
    }

    private com.ibm.icu.text.RuleBasedCollator ruleBased() {
        return (com.ibm.icu.text.RuleBasedCollator)delegate;
    }

    public void setCaseLevel(boolean value) { ruleBased().setCaseLevel(value); }
    public boolean isCaseLevel() { return ruleBased().isCaseLevel(); }
}
