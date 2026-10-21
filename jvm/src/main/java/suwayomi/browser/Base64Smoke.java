package suwayomi.browser;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Shared Android API, tested on both the native host and the browser JVM. */
public final class Base64Smoke {
    public static String verify() {
        byte[] bytes = new byte[256];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)i;
        for (int flags = 0; flags < 32; flags++) {
            var encoder = (flags & Base64.URL_SAFE) != 0 ? java.util.Base64.getUrlEncoder() : java.util.Base64.getEncoder();
            if ((flags & Base64.NO_PADDING) != 0) encoder = encoder.withoutPadding();
            for (int size : new int[]{0, 1, 2, 3, 55, 56, 57, 58, 76, 77, 255, 256}) {
                byte[] input = Arrays.copyOf(bytes, size);
                String raw = encoder.encodeToString(input);
                StringBuilder expected = new StringBuilder();
                if ((flags & Base64.NO_WRAP) != 0) expected.append(raw);
                else for (int start = 0; start < raw.length(); start += 76) {
                    expected.append(raw, start, Math.min(start + 76, raw.length()));
                    expected.append((flags & Base64.CRLF) != 0 ? "\r\n" : "\n");
                }
                String actual = Base64.encodeToString(input, flags);
                if (!actual.equals(expected.toString()) || !Arrays.equals(Base64.encode(input, flags), actual.getBytes(StandardCharsets.US_ASCII)) ||
                    !Arrays.equals(Base64.decode(actual, flags), input)) throw new AssertionError("Android Base64 flags " + flags + " length " + size);
            }
        }
        byte[] slice = {9, 102, 111, 111, 9};
        if (!Base64.encodeToString(slice, 1, 3, Base64.NO_WRAP).equals("Zm9v") ||
            !Arrays.equals(Base64.encode(slice, 1, 3, Base64.NO_WRAP), "Zm9v".getBytes(StandardCharsets.US_ASCII)) ||
            !Arrays.equals(Base64.decode("!Zm9v!".getBytes(StandardCharsets.US_ASCII), 1, 4, Base64.DEFAULT), "foo".getBytes(StandardCharsets.US_ASCII)) ||
            !Arrays.equals(Base64.decode(" Z!m#9$v\n", Base64.DEFAULT), "foo".getBytes(StandardCharsets.US_ASCII)))
            throw new AssertionError("Android Base64 slice or skipped characters");
        for (String invalid : new String[]{"A", "Zg=", "Z===", "=Zg=="}) {
            try { Base64.decode(invalid, Base64.DEFAULT); throw new AssertionError("Invalid padding accepted: " + invalid); }
            catch (IllegalArgumentException expected) {}
        }
        return "Android Base64: all flag combinations, binary values, line boundaries, slices, skipped characters and malformed padding verified";
    }
}
