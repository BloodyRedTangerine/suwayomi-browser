package android.text;

import java.util.Objects;

/** Immutable wrapped text block, rendered through the browser worker's Canvas2D implementation. */
public final class StaticLayout extends Layout {
    public StaticLayout(CharSequence source, TextPaint paint, int width, Alignment alignment,
                        float spacingMultiplier, float spacingExtra, boolean includePad) {
        super(source, paint, width, alignment, spacingMultiplier, spacingExtra, includePad);
    }

    private StaticLayout(CharSequence source, TextPaint paint, int width, Alignment alignment,
                         float spacingMultiplier, float spacingExtra, boolean includePad,
                         int breakStrategy, int hyphenationFrequency) {
        super(source, paint, width, alignment, spacingMultiplier, spacingExtra, includePad,
            breakStrategy, hyphenationFrequency);
    }

    /**
     * Browser-local builder. ICU supplies Unicode line/grapheme boundaries and the Canvas2D
     * worker applies simple or paragraph-optimized breaking. Android's exact paragraph scoring
     * and language-dictionary automatic hyphenation are not part of this browser implementation.
     */
    public static final class Builder {
        private final CharSequence source;
        private final TextPaint paint;
        private final int width;
        private Alignment alignment = Alignment.ALIGN_NORMAL;
        private int breakStrategy = BREAK_STRATEGY_SIMPLE;
        private int hyphenationFrequency = HYPHENATION_FREQUENCY_NONE;
        private float spacingMultiplier = 1.0f;
        private float spacingExtra;
        private boolean includePad = true;
        private boolean built;

        private Builder(CharSequence source, int start, int end, TextPaint paint, int width) {
            this.source = Objects.requireNonNull(source, "source").subSequence(start, end).toString();
            this.paint = Objects.requireNonNull(paint, "paint");
            if (width <= 0) throw new IllegalArgumentException("Layout width must be positive");
            this.width = width;
        }

        public static Builder obtain(CharSequence source, int start, int end, TextPaint paint, int width) {
            Objects.requireNonNull(source, "source");
            if (start < 0 || end < start || end > source.length())
                throw new IndexOutOfBoundsException("Text layout range outside source");
            return new Builder(source, start, end, paint, width);
        }

        public Builder setAlignment(Alignment value) {
            alignment = Objects.requireNonNull(value, "alignment");
            return this;
        }

        public Builder setBreakStrategy(int value) {
            if (value < BREAK_STRATEGY_SIMPLE || value > BREAK_STRATEGY_BALANCED)
                throw new IllegalArgumentException("Unknown line break strategy: " + value);
            breakStrategy = value;
            return this;
        }

        public Builder setHyphenationFrequency(int value) {
            if (value < HYPHENATION_FREQUENCY_NONE || value > HYPHENATION_FREQUENCY_FULL_FAST)
                throw new IllegalArgumentException("Unknown hyphenation frequency: " + value);
            hyphenationFrequency = value;
            return this;
        }

        public Builder setLineSpacing(float spacingAdd, float spacingMult) {
            if (!Float.isFinite(spacingAdd) || !Float.isFinite(spacingMult) || spacingMult < 0)
                throw new IllegalArgumentException("Invalid line spacing");
            spacingExtra = spacingAdd;
            spacingMultiplier = spacingMult;
            return this;
        }

        public Builder setIncludePad(boolean value) {
            includePad = value;
            return this;
        }

        public StaticLayout build() {
            if (built) throw new IllegalStateException("StaticLayout.Builder cannot be reused after build");
            built = true;
            return new StaticLayout(source, paint, width, alignment, spacingMultiplier, spacingExtra,
                includePad, breakStrategy, hyphenationFrequency);
        }
    }

    @Override public int getHeight() { return getLineCount() == 0 ? 0 : getRasterHeight(); }
}
