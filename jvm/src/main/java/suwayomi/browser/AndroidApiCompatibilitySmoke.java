package suwayomi.browser;

import android.app.Activity;
import android.icu.text.BreakIterator;
import android.icu.text.Collator;
import android.icu.text.Normalizer2;
import android.icu.text.RuleBasedCollator;
import android.icu.text.StringSearch;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.Html;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;
import java.text.StringCharacterIterator;

/** Behavioral checks for Android APIs newly found in source APK DEX. */
public final class AndroidApiCompatibilitySmoke {
    public static String verify() {
        Context context = new Context();
        if (!"SuwayomiBrowser".equals(Build.ID)) throw new AssertionError("Browser build identity was not initialized");
        Intent intent = new Intent().setAction(Intent.ACTION_VIEW).setData(Uri.parse("https://example.test/manga"))
            .putExtra("source", "fixture").putExtra("page", 4);
        if (!Intent.ACTION_VIEW.equals(intent.getAction()) || !"https://example.test/manga".equals(intent.getDataString()) ||
            !"fixture".equals(intent.getStringExtra("source")) || intent.getIntExtra("page", -1) != 4)
            throw new AssertionError("Intent action, URI, or typed extras failed");
        Activity activity = new Activity();
        activity.setIntent(intent); activity.onCreate(new Bundle());
        if (!"fixture".equals(activity.getIntent().getStringExtra("source"))) throw new AssertionError("Activity intent lifecycle failed");
        activity.finish();
        if (!activity.isFinishing()) throw new AssertionError("Activity finish state failed");
        Context.clearLastStartedIntent();
        new ContextWrapper(context).startActivity(intent);
        if (Context.getLastStartedIntent() == null || !"https://example.test/manga".equals(Context.getLastStartedIntent().getDataString()))
            throw new AssertionError("Local activity launch request was not retained");

        ViewGroup root = new ViewGroup(context);
        View child = new View(context); child.setId(42); root.addView(child);
        if (root.findViewById(42) != child || child.getRootView() != root || root.getChildCount() != 1)
            throw new AssertionError("View hierarchy lookup failed");
        child.setEnabled(false);
        if (child.isEnabled()) throw new AssertionError("View enabled state failed");
        root.removeView(child);
        if (child.getParent() != null || root.findViewById(42) != null) throw new AssertionError("View removal failed");

        TextView text = new TextView(context);
        text.setInputType(1);
        if (text.getInputType() != 1) throw new AssertionError("TextView input type state failed");
        int[] watcherCalls = {0};
        text.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) { watcherCalls[0]++; }
            public void onTextChanged(CharSequence value, int start, int before, int count) { watcherCalls[0]++; }
            public void afterTextChanged(android.text.Editable value) { watcherCalls[0]++; }
        });
        text.setText("ready"); text.setError("required");
        if (!"ready".contentEquals(text.getText()) || !"required".contentEquals(text.getError()) || watcherCalls[0] != 3)
            throw new AssertionError("TextView state or watcher dispatch failed");
        EditText edit = new EditText(context); edit.setInputType(1); edit.setSingleLine(true); edit.setText("query");
        edit.setHint("Search"); edit.setHorizontallyScrolling(true); edit.selectAll();
        if (edit.getInputType() != 1 || !edit.isSingleLine() || !"query".contentEquals(edit.getText()))
            throw new AssertionError("EditText inherited control state failed");
        if (!"Search".contentEquals(edit.getHint()) || !edit.getHorizontallyScrolling() ||
            edit.getSelectionStart() != 0 || edit.getSelectionEnd() != 5)
            throw new AssertionError("TextView hint, scrolling, or selection state failed");
        Toast toast = Toast.makeText(context, "Saved locally", Toast.LENGTH_SHORT);
        toast.show();
        if (!"Saved locally".contentEquals(toast.getText()) || toast.getDuration() != Toast.LENGTH_SHORT || !toast.isShown())
            throw new AssertionError("Browser-local Toast compatibility state failed");
        toast.cancel();
        if (toast.isShown()) throw new AssertionError("Toast cancellation state failed");
        String html = Html.fromHtml("<p>Hello <b>browser</b></p><p>two<br>lines</p>", Html.FROM_HTML_MODE_COMPACT).toString();
        if (!"Hello browser\ntwo\nlines".equals(html)) throw new AssertionError("HTML text extraction failed: " + html);
        String legacyHtml = Html.fromHtml("<p>first</p><p>second</p>", Html.FROM_HTML_MODE_LEGACY).toString();
        if (!"first\n\nsecond".equals(legacyHtml)) throw new AssertionError("Legacy HTML paragraph spacing failed: " + legacyHtml);

        Bitmap bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888);
        bitmap.setDensity(240);
        Canvas canvas = new Canvas(bitmap);
        int save = canvas.save(); canvas.translate(2, 1);
        Bitmap pixel = Bitmap.createBitmap(new int[]{0xffff0000}, 1, 1, Bitmap.Config.ARGB_8888);
        canvas.drawBitmap(pixel, 0, 0, null); canvas.restoreToCount(save);
        if (bitmap.getPixel(2, 1) != 0xffff0000 || bitmap.getPixel(0, 0) != 0)
            throw new AssertionError("Canvas save/translate/restore failed");
        Bitmap crop = Bitmap.createBitmap(bitmap, 2, 1, 1, 1);
        if (crop.getWidth() != 1 || crop.getHeight() != 1 || crop.getPixel(0, 0) != 0xffff0000 || crop.getDensity() != 240 || crop.isMutable())
            throw new AssertionError("Bitmap crop dimensions, pixels, density, or mutability failed");

        TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(0xff193b62); paint.setTextSize(18); paint.setTypeface(Typeface.create("serif", Typeface.BOLD));
        if (paint.getTypeface() == null || !paint.getTypeface().isBold()) throw new AssertionError("Paint Typeface state failed");
        String layoutSource = "xxBrowser-local text layout wraps words across a narrow area.yy";
        StaticLayout layout = StaticLayout.Builder.obtain(layoutSource, 2, layoutSource.length() - 2, paint, 86)
            .setAlignment(android.text.Layout.Alignment.ALIGN_CENTER)
            .setBreakStrategy(android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY)
            .setHyphenationFrequency(android.text.Layout.HYPHENATION_FREQUENCY_NORMAL)
            .setLineSpacing(0.0f, 1.0f).setIncludePad(true).build();
        if (!"Browser-local text layout wraps words across a narrow area.".contentEquals(layout.getText()) ||
            layout.getAlignment() != android.text.Layout.Alignment.ALIGN_CENTER ||
            layout.getBreakStrategy() != android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY ||
            layout.getHyphenationFrequency() != android.text.Layout.HYPHENATION_FREQUENCY_NORMAL)
            throw new AssertionError("StaticLayout.Builder did not retain its source range or layout options");
        if (layout.getLineCount() < 2 || layout.getHeight() <= 0) throw new AssertionError("StaticLayout wrapping or metrics failed");
        int lineEnd = 0;
        for (int line = 0; line < layout.getLineCount(); line++) {
            if (layout.getLineStart(line) != lineEnd || layout.getLineEnd(line) < lineEnd || layout.getLineWidth(line) < 0)
                throw new AssertionError("StaticLayout line ranges or widths were inconsistent");
            lineEnd = layout.getLineEnd(line);
        }
        if (lineEnd != layout.getText().length()) throw new AssertionError("StaticLayout line ranges do not cover the source text");
        try {
            layout.getLineEnd(layout.getLineCount());
            throw new AssertionError("StaticLayout accepted an out-of-range line index");
        } catch (IndexOutOfBoundsException expected) { }
        Bitmap textBitmap = Bitmap.createBitmap(86, layout.getHeight() + 4, Bitmap.Config.ARGB_8888);
        Canvas textCanvas = new Canvas(textBitmap); textCanvas.save(); textCanvas.translate(1, 2); layout.draw(textCanvas); textCanvas.restore();
        boolean ink = false;
        for (int y = 0; y < textBitmap.getHeight() && !ink; y++) for (int x = 0; x < textBitmap.getWidth(); x++)
            if ((textBitmap.getPixel(x, y) >>> 24) != 0) { ink = true; break; }
        if (!ink) throw new AssertionError("StaticLayout did not rasterize browser text");

        Normalizer2 normalizer = Normalizer2.getNFKCCasefoldInstance();
        if (!"key".equals(normalizer.normalize("ＫＥＹ"))) throw new AssertionError("ICU NFKC case folding failed");
        RuleBasedCollator collator = (RuleBasedCollator)Collator.getInstance();
        collator.setCaseLevel(false);
        collator.setDecomposition(Collator.CANONICAL_DECOMPOSITION);
        collator.setStrength(Collator.PRIMARY);
        StringSearch search = new StringSearch("manga", new StringCharacterIterator("Read Manga twice"), collator);
        if (search.first() != 5 || !"Manga".equals(search.getMatchedText()))
            throw new AssertionError("ICU collation-aware string search failed");
        search.setPattern("comic");
        search.setTarget(new StringCharacterIterator("A Comic reader"));
        if (search.first() != 2 || !"Comic".equals(search.getMatchedText()))
            throw new AssertionError("ICU string search target/pattern mutation failed");
        BreakIterator words = BreakIterator.getWordInstance();
        words.setText(new StringCharacterIterator("one two"));
        int wordStart = words.first(), wordEnd = words.next();
        if (wordStart != 0 || wordEnd <= wordStart || words.getRuleStatus() < 0)
            throw new AssertionError("ICU word boundary iteration failed");
        return "Android activity/intent state, View tree and TextView input/selection controls, Toast state, bitmap crop, HTML text extraction, Canvas transforms, ICU line/grapheme-aware StaticLayout.Builder line ranges, and ICU normalization/search/boundary APIs verified";
    }
}
