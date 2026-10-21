package suwayomi.browser

import java.io.ByteArrayOutputStream
import java.util.zip.DataFormatException
import java.util.zip.Deflater
import java.util.zip.Inflater

object InflaterSmoke {
    @JvmStatic fun verify() {
        println("Inflater probe: empty input")
        Inflater().useInflater { empty ->
            check(empty.inflate(ByteArray(8)) == 0)
            check(!empty.finished() && empty.needsInput()) { "No-progress inflater result became false EOF" }
        }
        val original = ByteArray(70_000) { ((it * 31 + it / 29) and 255).toByte() }
        val compressed = ByteArrayOutputStream()
        println("Inflater probe: compress")
        Deflater().useDeflater { deflater ->
            deflater.setInput(original); deflater.finish()
            val buffer = ByteArray(97)
            while (!deflater.finished()) { val count = deflater.deflate(buffer); compressed.write(buffer, 0, count) }
        }
        val encoded = compressed.toByteArray()
        println("Inflater probe: incremental decode")
        Inflater().useInflater { inflater ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(13)
            var input = 0
            while (!inflater.finished()) {
                if (inflater.needsInput()) {
                    check(input < encoded.size) { "Unexpected compressed stream EOF" }
                    val length = minOf(7, encoded.size - input)
                    inflater.setInput(encoded, input, length); input += length
                }
                val length = inflater.inflate(buffer)
                output.write(buffer, 0, length)
                check(!inflater.needsDictionary())
            }
            check(output.toByteArray().contentEquals(original))
            check(inflater.bytesWritten == original.size.toLong() && inflater.bytesRead == encoded.size.toLong())
            inflater.reset()
            check(!inflater.finished() && inflater.bytesWritten == 0L && inflater.needsInput())
        }
        println("Inflater probe: malformed data")
        Inflater().useInflater { invalid ->
            invalid.setInput(byteArrayOf(1, 2, 3, 4))
            check(runCatching { invalid.inflate(ByteArray(32)) }.exceptionOrNull() is DataFormatException) { "Corrupt deflate data was not rejected" }
        }
        val dictionary = "browser dictionary".toByteArray()
        println("Inflater probe: dictionary flag")
        val withDictionary = ByteArrayOutputStream()
        Deflater().useDeflater { deflater ->
            deflater.setDictionary(dictionary); deflater.setInput(dictionary); deflater.finish()
            val buffer = ByteArray(64)
            while (!deflater.finished()) { val count = deflater.deflate(buffer); withDictionary.write(buffer, 0, count) }
        }
        Inflater().useInflater { inflater ->
            inflater.setInput(withDictionary.toByteArray())
            check(inflater.inflate(ByteArray(64)) == 0 && inflater.needsDictionary() && !inflater.finished())
        }
        println("Inflater: no-progress is not EOF, incremental 70k round-trip/counters/reset, dictionary flag and malformed data rejection verified")
    }
    private inline fun <T> Inflater.useInflater(block: (Inflater) -> T): T = try { block(this) } finally { end() }
    private inline fun <T> Deflater.useDeflater(block: (Deflater) -> T): T = try { block(this) } finally { end() }
}
