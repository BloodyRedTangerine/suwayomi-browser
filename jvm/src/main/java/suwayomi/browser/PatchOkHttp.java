package suwayomi.browser;
import org.objectweb.asm.*;
import java.nio.file.*;
import java.time.*;
import java.util.zip.*;

/** Build-time replacement of OkHttp.newCall, including extension-created clients. */
public final class PatchOkHttp {
    public static void main(String[] args) throws Exception {
        // Fixed, time-zone independent entry timestamp (args[2] = SOURCE_DATE_EPOCH) keeps the output byte-reproducible.
        LocalDateTime stamp = LocalDateTime.ofEpochSecond(Math.max(Long.parseLong(args[2]), 315532800L), 0, ZoneOffset.UTC);
        try (ZipInputStream input = new ZipInputStream(Files.newInputStream(Path.of(args[0])));
             ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(Path.of(args[1])))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                byte[] bytes = input.readAllBytes();
                if (entry.getName().equals("okhttp3/OkHttpClient.class")) {
                    ClassReader reader = new ClassReader(bytes);
                    ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
                    reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                        @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                            MethodVisitor mv = super.visitMethod(access, name, descriptor, signature, exceptions);
                            if (!name.equals("newCall") || !descriptor.equals("(Lokhttp3/Request;)Lokhttp3/Call;")) return mv;
                            mv.visitCode();
                            mv.visitTypeInsn(Opcodes.NEW, "suwayomi/browser/BrowserCall");
                            mv.visitInsn(Opcodes.DUP);
                            mv.visitVarInsn(Opcodes.ALOAD, 0);
                            mv.visitVarInsn(Opcodes.ALOAD, 1);
                            mv.visitMethodInsn(Opcodes.INVOKESPECIAL, "suwayomi/browser/BrowserCall", "<init>", "(Lokhttp3/OkHttpClient;Lokhttp3/Request;)V", false);
                            mv.visitInsn(Opcodes.ARETURN);
                            mv.visitMaxs(0, 0);
                            mv.visitEnd();
                            return null;
                        }
                    }, 0);
                    bytes = writer.toByteArray();
                }
                if (entry.getName().equals("okio/FileSystem.class")) {
                    // Bovine loads the host on its bootstrap classpath. Okio assumes its
                    // resource class has a non-null loader; provide a resource-only loader
                    // without changing JVM Class.getClassLoader semantics or suffix rules.
                    ClassReader reader = new ClassReader(bytes);
                    ClassWriter writer = new ClassWriter(0);
                    reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                        @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                            MethodVisitor base = super.visitMethod(access, name, descriptor, signature, exceptions);
                            if (!name.equals("<clinit>")) return base;
                            return new MethodVisitor(Opcodes.ASM9, base) {
                                @Override public void visitMethodInsn(int opcode, String owner, String method, String desc, boolean isInterface) {
                                    if (opcode == Opcodes.INVOKEVIRTUAL && owner.equals("java/lang/Class") && method.equals("getClassLoader") && desc.equals("()Ljava/lang/ClassLoader;")) {
                                        super.visitMethodInsn(Opcodes.INVOKESTATIC, "suwayomi/browser/BrowserResources", "loader", "(Ljava/lang/Class;)Ljava/lang/ClassLoader;", false);
                                    } else super.visitMethodInsn(opcode, owner, method, desc, isInterface);
                                }
                            };
                        }
                    }, 0);
                    bytes = writer.toByteArray();
                }
                if (entry.getName().equals("com/squareup/zstd/JniZstdKt.class")) {
                    // Native codec methods are linked into the browser VM. Only skip
                    // the desktop shared-library extraction/load, not compression.
                    ClassReader reader = new ClassReader(bytes);
                    ClassWriter writer = new ClassWriter(0);
                    int[] replacements = {0};
                    reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                        @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                            MethodVisitor base = super.visitMethod(access, name, descriptor, signature, exceptions);
                            if (!name.equals("<clinit>")) return base;
                            return new MethodVisitor(Opcodes.ASM9, base) {
                                @Override public void visitMethodInsn(int opcode, String owner, String method, String desc, boolean isInterface) {
                                    if (opcode == Opcodes.INVOKESTATIC && owner.equals("com/squareup/zstd/Zstd") && method.equals("loadNativeLibrary") && desc.equals("()V")) replacements[0]++;
                                    else super.visitMethodInsn(opcode, owner, method, desc, isInterface);
                                }
                            };
                        }
                    }, 0);
                    if (replacements[0] != 1) throw new IllegalStateException("Unexpected Zstd desktop-loader bytecode");
                    bytes = writer.toByteArray();
                }
                ZipEntry written = new ZipEntry(entry.getName());
                written.setTimeLocal(stamp);
                output.putNextEntry(written);
                output.write(bytes);
                output.closeEntry();
            }
        }
    }
}
