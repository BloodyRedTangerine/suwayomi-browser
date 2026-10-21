package suwayomi.browser;

import com.googlecode.d2j.Method;
import com.googlecode.d2j.reader.BaseDexFileReader;
import com.googlecode.d2j.visitors.DexFileVisitor;
import com.googlecode.dex2jar.ir.expr.Exprs;
import com.googlecode.dex2jar.ir.expr.Value;
import org.objectweb.asm.*;
import java.util.*;

/** Synthetic regression: wide arguments, multiple inlined ancestors and collisions. */
final class ConstructorBridgeSmoke implements Opcodes {
    static void verify() throws Exception {
        var reader = new BaseDexFileReader() {
            public int getDexVersion() { return 39; }
            public List<String> getClassNames() { return List.of("Ltest/Ancestor;", "Ltest/Parent;", "Ltest/Child;"); }
            public void accept(DexFileVisitor visitor) { accept(visitor, 0); }
            public void accept(DexFileVisitor visitor, int flags, int index) { throw new UnsupportedOperationException(); }
            public void accept(DexFileVisitor visitor, int flags) {
                for (String name : getClassNames()) {
                    String parent = name.equals("Ltest/Ancestor;") ? "Ljava/lang/Object;" : name.equals("Ltest/Parent;") ? "Ltest/Ancestor;" : "Ltest/Parent;";
                    var clazz = visitor.visit(ACC_PUBLIC, name, parent, new String[0]);
                    clazz.visitMethod(ACC_PUBLIC, new Method(name, "<init>", new String[]{"J", "D"}, "V"));
                    clazz.visitMethod(ACC_PUBLIC, new Method(name, "<init>", new String[]{"J", "D", "Ljava/lang/Void;"}, "V"));
                    clazz.visitEnd();
                }
            }
        };
        ConstructorBridges registry = ConstructorBridges.begin(reader);
        try {
            var expression = ConstructorBridges.invokeNew(new Value[]{Exprs.nConstant(7L), Exprs.nConstant(3.5)}, new String[]{"J", "D"}, "Ltest/Child;", "Ltest/Ancestor;");
            if (expression.getArgs().length != 4) throw new AssertionError("Constructor signature collision was not avoided");
        } finally { ConstructorBridges.end(); }
        var bytes = new HashMap<String, byte[]>();
        for (String name : List.of("Ancestor", "Parent", "Child")) {
            ClassWriter writer = new ClassWriter(0);
            ClassVisitor cv = registry.visitor(writer);
            String parent = name.equals("Ancestor") ? "java/lang/Object" : "test/" + (name.equals("Parent") ? "Ancestor" : "Parent");
            cv.visit(V17, ACC_PUBLIC, "test/" + name, null, parent, null);
            if (name.equals("Ancestor")) {
                cv.visitField(ACC_PUBLIC, "x", "J", null, null).visitEnd();
                cv.visitField(ACC_PUBLIC, "y", "D", null, null).visitEnd();
                cv.visitField(ACC_PUBLIC | ACC_STATIC, "calls", "I", null, null).visitEnd();
            }
            for (String descriptor : List.of("(JD)V", "(JDLjava/lang/Void;)V")) {
                var mv = cv.visitMethod(ACC_PUBLIC, "<init>", descriptor, null, null);
                mv.visitCode();
                if (name.equals("Ancestor") && descriptor.equals("(JD)V")) {
                    mv.visitVarInsn(ALOAD, 0); mv.visitMethodInsn(INVOKESPECIAL, parent, "<init>", "()V", false);
                    mv.visitVarInsn(ALOAD, 0); mv.visitVarInsn(LLOAD, 1); mv.visitFieldInsn(PUTFIELD, "test/Ancestor", "x", "J");
                    mv.visitVarInsn(ALOAD, 0); mv.visitVarInsn(DLOAD, 3); mv.visitFieldInsn(PUTFIELD, "test/Ancestor", "y", "D");
                    mv.visitFieldInsn(GETSTATIC, "test/Ancestor", "calls", "I"); mv.visitInsn(ICONST_1); mv.visitInsn(IADD);
                    mv.visitFieldInsn(PUTSTATIC, "test/Ancestor", "calls", "I"); mv.visitInsn(RETURN);
                } else {
                    // These constructors represent side effects already inlined by
                    // R8. A restoration bridge must never invoke them again.
                    mv.visitTypeInsn(NEW, "java/lang/AssertionError"); mv.visitInsn(DUP);
                    mv.visitMethodInsn(INVOKESPECIAL, "java/lang/AssertionError", "<init>", "()V", false); mv.visitInsn(ATHROW);
                }
                mv.visitMaxs(4, descriptor.contains("Void") ? 6 : 5); mv.visitEnd();
            }
            cv.visitEnd(); bytes.put("test." + name, writer.toByteArray());
        }
        var loader = new ClassLoader(ConstructorBridgeSmoke.class.getClassLoader()) {
            @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
                byte[] data = bytes.get(name); if (data == null) throw new ClassNotFoundException(name);
                return defineClass(name, data, 0, data.length);
            }
        };
        var type = loader.loadClass("test.Child");
        Object value = type.getConstructor(long.class, double.class, Void.class, Void.class).newInstance(7L, 3.5, null, null);
        if (type.getField("x").getLong(value) != 7L || type.getField("y").getDouble(value) != 3.5 || type.getField("calls").getInt(null) != 1)
            throw new AssertionError("Forwarded constructor arguments or side effects changed");
        System.out.println("Generic constructor bridges: hierarchy, signature collision and wide arguments verified");
    }
}
