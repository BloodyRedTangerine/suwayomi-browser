package suwayomi.browser;

import android.content.Context;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.Arrays;

/** Isolated guest-JVM checks, never run against the native host filesystem. */
public final class RandomAccessProbe {
    private static File file() { return new Context().getFileStreamPath("随机😀.bin"); }
    private interface Action { void run() throws Exception; }
    private static void expect(Class<? extends Throwable> type, Action action) throws Exception {
        try { action.run(); } catch (Throwable failure) {
            if (type.isInstance(failure)) return;
            throw new AssertionError("Expected " + type.getName() + ", got " + failure, failure);
        }
        throw new AssertionError("Expected " + type.getName());
    }
    public static String write() throws Exception {
        var raf = new RandomAccessFile(file(), "rw");
        try {
            if (!raf.getFD().valid()) throw new AssertionError("Random-access descriptor is invalid");
            raf.setLength(0); raf.seek(0);
            raf.write(new byte[]{9, 0, (byte)128, (byte)255, 9}, 1, 3); raf.write(0x107);
            raf.seek(1);
            if (raf.length() != 4 || raf.getFilePointer() != 1 || raf.read() != 128) throw new AssertionError("Length moved cursor or binary read failed");
            byte[] destination = new byte[]{9, 9, 9, 9};
            if (raf.read(destination, 1, 3) != 2 || !Arrays.equals(destination, new byte[]{9, (byte)255, 7, 9}) || raf.read(destination) != -1 || raf.read(destination, 0, 0) != 0) throw new AssertionError("Bulk read offsets/EOF failed");
            expect(IndexOutOfBoundsException.class, () -> raf.read(destination, Integer.MAX_VALUE, 1));
            expect(IndexOutOfBoundsException.class, () -> raf.write(destination, -1, 1));
            expect(NullPointerException.class, () -> raf.read(null, 0, 1));
            expect(NullPointerException.class, () -> raf.write(null, 0, 1));
            expect(IOException.class, () -> raf.seek(-1));
            expect(IOException.class, () -> raf.setLength(-1));
            raf.seek(20); raf.write(0x188);
            if (raf.length() != 21 || raf.getFilePointer() != 21) throw new AssertionError("Seek/write extension failed");
            raf.seek(4); byte[] gap = new byte[16]; raf.readFully(gap);
            if (!Arrays.equals(gap, new byte[16]) || raf.read() != 136) throw new AssertionError("Guest filesystem gap bytes failed");
            raf.setLength(8);
            if (raf.getFilePointer() != 8 || raf.length() != 8) throw new AssertionError("Truncate did not clip cursor");
            raf.seek(2); raf.setLength(12);
            if (raf.getFilePointer() != 2 || raf.length() != 12) throw new AssertionError("Extension moved cursor");
            var channel = raf.getChannel(); channel.position(1);
            if (raf.getFilePointer() != 1) throw new AssertionError("Channel and random access have different cursors");
            var buffer = ByteBuffer.allocate(1);
            if (channel.read(buffer, 0) != 1 || buffer.get(0) != 0 || raf.getFilePointer() != 1) throw new AssertionError("Positional channel read moved shared cursor");
            raf.setLength(0); raf.seek(0);
            raf.writeInt(0x12345678); raf.writeLong(Long.MAX_VALUE); raf.writeBoolean(true); raf.writeUTF("Café 日本語 😀");
            raf.getFD().sync();
        } finally { raf.close(); }
        if (raf.getFD().valid()) throw new AssertionError("Closing random access did not invalidate descriptor");
        raf.close();
        expect(IOException.class, raf::read);
        expect(IOException.class, () -> raf.write(1));
        expect(IOException.class, raf::length);
        expect(IOException.class, () -> raf.seek(0));
        expect(IOException.class, () -> raf.setLength(1));
        expect(SyncFailedException.class, () -> raf.getFD().sync());
        if (raf.read(new byte[0]) != 0) throw new AssertionError("Zero-length closed bulk read failed");
        raf.write(new byte[0]);
        try (var output = new FileOutputStream(new Context().getFileStreamPath("stream-access.bin"))) {
            output.write(42);
            try (var sharedInput = new FileInputStream(output.getFD())) { expect(IOException.class, sharedInput::read); }
        }
        verify();
        for (String mode : new String[]{"rws", "rwd"}) {
            try (var synced = new RandomAccessFile(new Context().getFileStreamPath("random-" + mode + ".bin"), mode)) { synced.setLength(0); synced.writeInt(42); synced.getFD().sync(); }
        }
        new Context().getSharedPreferences("filesystem-fixture", 0).edit().putBoolean("randomFixture", true).commit();
        return "Random-access writes, shared channel cursor, size/truncate/extend, typed values, bounds/EOF/closed errors and guest sync modes verified";
    }
    public static String verify() throws Exception {
        try (var readOnly = new RandomAccessFile(file(), "r")) {
            long size = readOnly.length();
            if (readOnly.getFilePointer() != 0 || readOnly.readInt() != 0x12345678 || readOnly.readLong() != Long.MAX_VALUE || !readOnly.readBoolean() || !readOnly.readUTF().equals("Café 日本語 😀") || readOnly.getFilePointer() != size) throw new AssertionError("Random-access typed file round trip failed");
            expect(IOException.class, () -> readOnly.write(1));
            expect(IOException.class, () -> readOnly.setLength(size));
            expect(EOFException.class, () -> readOnly.readFully(new byte[1]));
            if (readOnly.read() != -1 || readOnly.read(new byte[1]) != -1) throw new AssertionError("Random-access EOF failed");
            try (var sharedOutput = new FileOutputStream(readOnly.getFD())) { expect(IOException.class, () -> sharedOutput.write(1)); }
        }
        File missing = new Context().getFileStreamPath("missing-随机😀.bin");
        expect(FileNotFoundException.class, () -> { try (var ignored = new RandomAccessFile(missing, "r")) {} });
        expect(FileNotFoundException.class, () -> { try (var ignored = new RandomAccessFile(new Context().getFilesDir(), "r")) {} });
        return "Cold read-only random access preserves typed binary/Unicode data and correct failure behavior";
    }
}
