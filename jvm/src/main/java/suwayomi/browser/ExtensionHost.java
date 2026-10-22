package suwayomi.browser;

import com.googlecode.d2j.dex.Dex2jar;
import com.googlecode.d2j.reader.MultiDexFileReader;
import net.dongliu.apk.parser.ApkFile;
import java.nio.file.Path;
import java.nio.file.Files;
import java.net.URL;
import java.net.URLClassLoader;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.commons.ClassRemapper;
import org.objectweb.asm.commons.Remapper;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.util.HashSet;

/** Executes extension bytecode in a browser JVM; no process or server is started. */
public final class ExtensionHost {
    public static String smoke() throws Exception {
        return "JVM bytecode execution: " + (6 * 7) + "; Java " + System.getProperty("java.version");
    }
    public static String filesystemProbe(String action) throws Exception { return FilesystemProbe.run(action); }
    public static String zstdProbe() { return ZstdSmoke.verify(); }
    public static String zstdSafetyProbe() { return ZstdSmoke.verifyBrowserSafety(); }
    public static String localeDataProbe() { return LocaleDataProbe.verify(); }
    public static String runtimeResourceProbe() { return RuntimeResourceProbe.run(); }
    public static String jvmDefaultsProbe() { return JvmDefaultsProbe.snapshot(); }
    public static String dateFailureProbe(String value) { return DateFailureProbe.run(value); }
    public static String exceptionHandlingProbe() throws Exception { return ExceptionHandlingProbe.run(); }
    public static String graphicsProbe() throws Exception { return GraphicsProbe.verify(); }
    public static String androidApiProbe() { return AndroidApiCompatibilitySmoke.verify(); }
    public static String webViewProbe() throws Exception { return WebViewProbe.verify(); }
    public static String webViewLoadUrlProbe(String url) throws Exception { return WebViewProbe.verifyLoadUrl(url); }
    public static String stringEcho(String value) { return new String(value.toCharArray()); }
    public static String verifyJarSignature(String path) throws Exception { return JarSignatureVerifier.verify(Path.of(path)); }
    public static String base64Probe() { return Base64Smoke.verify(); }
    public static String webkitCookieProbe() { return WebkitCookieSmoke.verify(); }
    public static String referenceProbe() throws Exception { return ReferenceSmoke.verify(); }
    public static String sourceControlsProbe() {
        NetworkCompatSmoke.verify();
        CookieStoreSmoke.verify();
        FollowUpSmoke.verify();
        RequestBodySmoke.verify();
        InflaterSmoke.verify();
        SourceChapterSmoke.verify();
        CombinedUpdateSmoke.verify("/extensions/host.jar");
        SourceFilterSmoke.verify();
        SourcePreferenceSmoke.verify();
        PreferenceReloadSmoke.verify("/extensions/host.jar");
        return "Filter and preference compatibility probes passed";
    }
    public static String requestBodyProbe() { return RequestBodySmoke.roundTrip(); }
    public static String binaryReadProbe() throws Exception {
        java.io.File file = new java.io.File("/cache/browser-byte-probe-" + System.nanoTime());
        try {
            Files.write(file.toPath(), new byte[]{0, (byte)128, (byte)255});
            try (var input = new java.io.FileInputStream(file)) {
                if (input.read() != 0 || input.read() != 128 || input.read() != 255 || input.read() != -1)
                    throw new AssertionError("Binary FileInputStream.read lost unsigned bytes");
            }
            return "Binary file read verified";
        } finally { file.delete(); }
    }
    public static String reflectionProbe() {
        uy.kohesive.injekt.api.FullTypeReference<eu.kanade.tachiyomi.network.NetworkHelper> token =
            new uy.kohesive.injekt.api.FullTypeReference<eu.kanade.tachiyomi.network.NetworkHelper>() {};
        return "Captured type: " + token.getType() + "; superclass: " + token.getClass().getGenericSuperclass();
    }

    public static String manifest(String apkPath) throws Exception {
        try (ApkFile apk = new ApkFile(apkPath)) { return apk.getManifestXml(); }
    }

    public static synchronized void convert(String apkPath, String jarPath) throws Exception {
        // dex2jar's memory output is a sequence of length-prefixed class
        // names and byte arrays. Avoid its filesystem/ZipFS output path:
        // browser conversion needs no temporary native directory or provider.
        ByteArrayOutputStream translated = new ByteArrayOutputStream();
        var dex = MultiDexFileReader.open(Files.readAllBytes(Path.of(apkPath)));
        var constructors = ConstructorBridges.begin(dex);
        try {
        Dex2jar.from(dex)
            .withExceptionHandler(new com.googlecode.d2j.dex.DexExceptionHandler() {
                public void handleFileException(Exception error) { throw new IllegalArgumentException("DEX conversion failed", error); }
                public void handleMethodTranslateException(com.googlecode.d2j.Method method, com.googlecode.d2j.node.DexMethodNode node, MethodVisitor visitor, Exception error) {
                    throw new IllegalArgumentException("DEX method conversion failed: " + method, error);
                }
            })
            .reUseReg(false).topoLogicalSort().skipDebug(true)
            .optimizeSynchronized(false).printIR(false).noCode(false)
            .skipExceptions(false).dontSanitizeNames(true).computeFrames(true)
            .doTranslate(translated);
        } finally { ConstructorBridges.end(); }
        // dex2jar can emit java/util/Object in stack-map frames after merging
        // generic collection values. The actual DEX type is java/lang/Object.
        // Also preserve resources needed by extensions after conversion.
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        HashSet<String> names = new HashSet<>();
        try (ZipOutputStream output = new ZipOutputStream(buffer)) {
            try (DataInputStream classes = new DataInputStream(new ByteArrayInputStream(translated.toByteArray()))) {
                while (classes.available() > 0) {
                    int nameSize = classes.readInt();
                    if (nameSize <= 0 || nameSize > 16384) throw new java.io.IOException("Invalid converted class name length");
                    String name = new String(classes.readNBytes(nameSize), java.nio.charset.StandardCharsets.UTF_8) + ".class";
                    int size = classes.readInt();
                    if (size <= 0 || size > 64 * 1024 * 1024) throw new java.io.IOException("Invalid converted class length");
                    byte[] bytes = classes.readNBytes(size);
                    if (bytes.length != size) throw new java.io.IOException("Truncated converted class");
                    {
                        ClassReader reader = new ClassReader(bytes);
                        ClassWriter writer = new ClassWriter(0);
                        reader.accept(new ClassRemapper(constructors.visitor(writer), new Remapper() {
                            @Override public String map(String type) {
                                return type.equals("java/util/Object") ? "java/lang/Object" : type;
                            }
                        }), 0);
                        bytes = writer.toByteArray();
                    }
                    output.putNextEntry(new ZipEntry(name));
                    output.write(bytes);
                    output.closeEntry();
                    names.add(name);
                }
            }
            try (ZipInputStream apk = new ZipInputStream(Files.newInputStream(Path.of(apkPath)))) {
                ZipEntry entry;
                while ((entry = apk.getNextEntry()) != null) {
                    String name = entry.getName();
                    if (names.contains(name) || entry.isDirectory() || !(name.startsWith("assets/") || name.startsWith("res/") || name.equals("resources.arsc"))) continue;
                    output.putNextEntry(new ZipEntry(name));
                    apk.transferTo(output);
                    output.closeEntry();
                }
            }
            output.putNextEntry(new ZipEntry("AndroidManifest.xml"));
            output.write(manifest(apkPath).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            output.closeEntry();
        }
        Files.write(Path.of(jarPath), buffer.toByteArray());
    }

    public static String instantiate(String jarPath, String className) throws Exception {
        URLClassLoader loader = new URLClassLoader(new URL[]{Path.of(jarPath).toUri().toURL()}, ExtensionHost.class.getClassLoader());
        return Class.forName(className, true, loader).getDeclaredConstructor().newInstance().getClass().getName();
    }
}
