package android.icu.text;

import java.text.CharacterIterator;

/** ICU collation-aware string search facade for Android source extensions. */
public final class StringSearch extends SearchIterator {
    public StringSearch(String pattern, CharacterIterator target, RuleBasedCollator collator) {
        super(new com.ibm.icu.text.StringSearch(pattern, target,
            (com.ibm.icu.text.RuleBasedCollator)java.util.Objects.requireNonNull(collator, "collator").delegate));
    }

    private com.ibm.icu.text.StringSearch stringSearch() {
        return (com.ibm.icu.text.StringSearch)delegate;
    }

    public void setPattern(String value) { stringSearch().setPattern(value); }
    public void setTarget(CharacterIterator value) { stringSearch().setTarget(value); }
}
