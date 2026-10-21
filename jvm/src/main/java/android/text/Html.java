package android.text;

import org.jsoup.nodes.Element;
import org.jsoup.nodes.Node;
import org.jsoup.nodes.TextNode;
import java.util.Locale;

/** HTML-to-text conversion backed by the same parser used by source adapters. */
public final class Html {
    public static final int FROM_HTML_MODE_LEGACY = 0;
    public static final int FROM_HTML_MODE_COMPACT = 63;
    private Html() {}
    public static Spanned fromHtml(String source, int flags) {
        Element body = org.jsoup.Jsoup.parseBodyFragment(source == null ? "" : source).body();
        StringBuilder output = new StringBuilder();
        int blockBreaks = (flags & FROM_HTML_MODE_COMPACT) == FROM_HTML_MODE_COMPACT ? 1 : 2;
        append(body, output, blockBreaks);
        String text = output.toString().replaceAll("[\\t\\x0B\\f\\r ]+", " ")
            .replaceAll(" *\\n *", "\n").replaceAll("\\n{3,}", blockBreaks == 1 ? "\n" : "\n\n").strip();
        return new SpannedString(text);
    }
    private static void append(Node node, StringBuilder output, int blockBreaks) {
        if (node instanceof TextNode text) { output.append(text.getWholeText()); return; }
        boolean block = node instanceof Element element && isBlock(element.normalName());
        if (node instanceof Element element && element.normalName().equals("br")) { output.append('\n'); return; }
        if (block && output.length() > 0 && output.charAt(output.length() - 1) != '\n') output.append("\n".repeat(blockBreaks));
        for (Node child : node.childNodes()) append(child, output, blockBreaks);
        if (block && output.length() > 0 && output.charAt(output.length() - 1) != '\n') output.append("\n".repeat(blockBreaks));
    }
    private static boolean isBlock(String name) {
        return switch (name.toLowerCase(Locale.ROOT)) {
            case "address", "article", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "ol", "p", "pre", "section", "table", "tr", "ul" -> true;
            default -> false;
        };
    }
}
