package suwayomi.browser

import com.squareup.zstd.getErrorName
import com.squareup.zstd.zstdCompressor
import com.squareup.zstd.zstdDecompressor
import com.squareup.zstd.okio.zstdCompress
import com.squareup.zstd.okio.zstdDecompress
import okio.Buffer
import okio.buffer

object ZstdSmoke {
    /** Browser bridge validation; desktop JNI does not promise safe invalid-array calls. */
    @JvmStatic fun verifyBrowserSafety(): String {
        fun rejects(type: Class<out Throwable>, block: () -> Unit) {
            try { block() } catch (error: Throwable) {
                check(type.isInstance(error)) { "Expected ${type.name}, got $error" }
                return
            }
            error("Invalid native arguments were accepted")
        }
        zstdCompressor().use { compressor ->
            val output = ByteArray(32); val input = byteArrayOf(1, 2, 3)
            for ((start, end) in listOf(-1 to 32, 0 to 33, 4 to 3, 0 to -1)) {
                rejects(IndexOutOfBoundsException::class.java) { compressor.compressStream2(output, end, start, input, 3, 0, 2) }
            }
            rejects(IndexOutOfBoundsException::class.java) { compressor.compressStream2(output, 32, 0, input, 4, 0, 2) }
            rejects(IndexOutOfBoundsException::class.java) { compressor.compressStream2(output, 32, 0, input, 3, -1, 2) }
            for (mode in listOf(-1, 3, Int.MAX_VALUE)) rejects(IllegalArgumentException::class.java) { compressor.compressStream2(output, 32, 0, input, 3, 0, mode) }
            compressor.close()
            rejects(IllegalStateException::class.java) { compressor.setParameter(100, 3) }
            rejects(IllegalStateException::class.java) { compressor.compressStream2(output, 32, 0, input, 3, 0, 2) }
        }
        zstdDecompressor().use { decompressor ->
            val output = ByteArray(32); val input = ByteArray(16)
            rejects(IndexOutOfBoundsException::class.java) { decompressor.decompressStream(output, 33, 0, input, 16, 0) }
            rejects(IndexOutOfBoundsException::class.java) { decompressor.decompressStream(output, 32, 0, input, 17, 0) }
            rejects(IndexOutOfBoundsException::class.java) { decompressor.decompressStream(output, 32, 0, input, 16, -1) }
            decompressor.close()
            rejects(IllegalStateException::class.java) { decompressor.decompressStream(output, 32, 0, input, 16, 0) }
        }
        check(verify().isNotEmpty())
        return "Browser Zstandard rejects invalid array windows, invalid modes and closed contexts; valid codec works afterward"
    }
    @JvmStatic fun verify(): String {
        // Independent standard raw-block frame, not produced by the implementation under test.
        val hello = byteArrayOf(0x28, 0xb5.toByte(), 0x2f, 0xfd.toByte(), 0x20, 5, 0x29, 0, 0, 104, 101, 108, 108, 111)
        check(Buffer().write(hello).zstdDecompress().buffer().use { it.readUtf8() } == "hello")
        for (size in listOf(0, 1, 256, 131073)) {
            val input = ByteArray(size) { ((it * 31 + it / 256) and 255).toByte() }
            val output = Buffer()
            output.zstdCompress().buffer().use { sink ->
                var offset = 0
                while (offset < size) {
                    val length = minOf(127, size - offset)
                    sink.write(input, offset, length)
                    if (offset % 254 == 0) sink.flush()
                    offset += length
                }
            }
            check(output.clone().readByteArray(4).contentEquals(hello.copyOfRange(0, 4)))
            check(output.zstdDecompress().buffer().use { it.readByteArray() }.contentEquals(input))
        }
        zstdCompressor().use { compressor ->
            check(getErrorName(compressor.setParameter(100, 3)) == null)
            check(getErrorName(compressor.setParameter(Int.MAX_VALUE, 1)) != null)
            val input = byteArrayOf(99, 104, 101, 108, 108, 111, 99)
            val output = ByteArray(100) { 77 }
            val code = compressor.compressStream2(output, 90, 3, input, 6, 1, 2)
            check(getErrorName(code) == null && code == 0L)
            check(compressor.inputBytesProcessed == 5 && compressor.outputBytesProcessed > 0 && output.take(3).all { it == 77.toByte() })
            val encoded = output.copyOfRange(3, 3 + compressor.outputBytesProcessed)
            check(Buffer().write(encoded).zstdDecompress().buffer().use { it.readUtf8() } == "hello")
        }
        zstdDecompressor().use { decompressor ->
            val output = ByteArray(32) { 77 }
            val code = decompressor.decompressStream(output, 20, 2, hello, hello.size, 0)
            check(code == 0L && decompressor.inputBytesProcessed == hello.size && decompressor.outputBytesProcessed == 5)
            check(output.copyOfRange(2, 7).decodeToString() == "hello" && output[0] == 77.toByte() && output[7] == 77.toByte())
        }
        zstdDecompressor().use { decompressor ->
            check(getErrorName(decompressor.decompressStream(ByteArray(32), 32, 0, ByteArray(16), 16, 0)) != null)
        }
        return "Zstandard raw-frame interoperability, chunked/flush/empty/binary round trips, offsets, byte counters and native errors verified"
    }
}
