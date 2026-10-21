package suwayomi.browser;

import java.io.InputStream;
import java.nio.file.Path;
import java.security.CodeSigner;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.Enumeration;
import java.util.jar.JarFile;
import java.util.TreeSet;
import java.util.Locale;

/** Strict JAR-v1 verification using the browser JVM's bundled Java security APIs. */
final class JarSignatureVerifier {
    private JarSignatureVerifier() {}

    private static boolean isSignatureMetadata(String name) {
        if (!name.regionMatches(true, 0, "META-INF/", 0, 9)) return false;
        String metadataName = name.substring(9);
        if (metadataName.isEmpty() || metadataName.indexOf('/') >= 0) return false;
        String upper = metadataName.toUpperCase(Locale.ROOT);
        return upper.equals("MANIFEST.MF") || upper.endsWith(".SF") || upper.endsWith(".RSA")
            || upper.endsWith(".DSA") || upper.endsWith(".EC") || upper.startsWith("SIG-");
    }

    static String verify(Path path) throws Exception {
        boolean foundPayload = false;
        TreeSet<String> fingerprints = new TreeSet<>();
        Set<String> names = new HashSet<>();
        try (JarFile jar = new JarFile(path.toFile(), true)) {
            Enumeration<JarEntry> entries = jar.entries();
            byte[] buffer = new byte[16 * 1024];
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                if (!names.add(entry.getName())) throw new SecurityException("JAR contains duplicate entry names");
                try (InputStream content = jar.getInputStream(entry)) {
                    while (content.read(buffer) != -1) { /* consume bytes so JarVerifier checks digests */ }
                }
                if (entry.isDirectory() || isSignatureMetadata(entry.getName())) continue;
                foundPayload = true;
                CodeSigner[] signers = entry.getCodeSigners();
                if (signers == null || signers.length != 1)
                    throw new SecurityException("JAR payload entry is unsigned or has multiple signers");
                Certificate[] chain = signers[0].getSignerCertPath().getCertificates().toArray(Certificate[]::new);
                if (chain.length == 0) throw new SecurityException("JAR signer certificate chain is empty");
                fingerprints.add(HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded())
                ));
                if (fingerprints.size() > 1) throw new SecurityException("JAR payload has inconsistent signers");
            }
        }
        if (!foundPayload || fingerprints.size() != 1)
            throw new SecurityException("JAR has no signed payload entries");
        return "jar-v1:" + fingerprints.first();
    }
}
