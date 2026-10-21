package android.graphics;

import java.util.Objects;

/** Typeface descriptor translated to an installed browser font family at raster time. */
public final class Typeface {
    public static final int NORMAL = 0, BOLD = 1, ITALIC = 2, BOLD_ITALIC = 3;
    public static final Typeface DEFAULT = new Typeface("sans-serif", NORMAL);
    public static final Typeface DEFAULT_BOLD = new Typeface("sans-serif", BOLD);
    public static final Typeface SANS_SERIF = DEFAULT;
    public static final Typeface SERIF = new Typeface("serif", NORMAL);
    public static final Typeface MONOSPACE = new Typeface("monospace", NORMAL);
    private final String family;
    private final int style;

    private Typeface(String family, int style) { this.family = family; this.style = style & 3; }
    public static Typeface create(String familyName, int style) { return new Typeface(familyName == null || familyName.isBlank() ? "sans-serif" : familyName, style); }
    public static Typeface create(Typeface family, int style) { return create(family == null ? null : family.family, style); }
    public static Typeface defaultFromStyle(int style) { return create(DEFAULT, style); }
    public String getFamily() { return family; }
    public int getStyle() { return style; }
    public boolean isBold() { return (style & BOLD) != 0; }
    public boolean isItalic() { return (style & ITALIC) != 0; }
    @Override public boolean equals(Object other) { return other instanceof Typeface face && family.equals(face.family) && style == face.style; }
    @Override public int hashCode() { return Objects.hash(family, style); }
}
