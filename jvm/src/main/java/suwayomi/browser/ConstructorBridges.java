package suwayomi.browser;

import com.googlecode.d2j.node.DexFileNode;
import com.googlecode.d2j.reader.BaseDexFileReader;
import com.googlecode.d2j.reader.DexFileReader;
import com.googlecode.dex2jar.ir.expr.Exprs;
import com.googlecode.dex2jar.ir.expr.InvokeExpr;
import com.googlecode.dex2jar.ir.expr.Value;
import java.util.*;
import org.objectweb.asm.*;

/** Restores JVM constructors removed by R8, without rerunning inlined side effects.
 * DEX permits NEW Child + invoke-direct Ancestor.<init>; JVM requires a constructor
 * on Child. Unique null marker arguments distinguish bridges from existing ctors.
 */
public final class ConstructorBridges {
    // Host conversion is serialized. A VM may resume deep conversion work on a
    // scheduler thread, so this registry belongs to the conversion, not a thread.
    private static ConstructorBridges active;
    private static final String MARKER = "Ljava/lang/Void;";
    private final Map<String, String> parents = new HashMap<>();
    private final Map<String, Set<String>> signatures = new HashMap<>();
    private final Map<String, Bridge> bridges = new LinkedHashMap<>();
    private record Bridge(String type, String owner, String[] args, String descriptor, int markers, Bridge parent) {}

    public static ConstructorBridges begin(BaseDexFileReader reader) {
        var registry = new ConstructorBridges();
        var dex = new DexFileNode();
        reader.accept(dex, DexFileReader.SKIP_CODE);
        for (var clazz : dex.clzs) {
            registry.parents.put(clazz.className, clazz.superClass);
            var descriptors = new HashSet<String>();
            if (clazz.methods != null) for (var method : clazz.methods)
                if (method.method.getName().equals("<init>")) descriptors.add(method.method.getDesc());
            registry.signatures.put(clazz.className, descriptors);
        }
        active = registry;
        return registry;
    }
    public static void end() { active = null; }
    private static String descriptor(String[] args, int markers) {
        return "(" + String.join("", args) + MARKER.repeat(markers) + ")V";
    }
    private Bridge bridge(String type, String owner, String[] args, Set<String> visiting) {
        String key = type + ":" + owner + descriptor(args, 0);
        if (bridges.containsKey(key)) return bridges.get(key);
        if (!visiting.add(type)) throw new IllegalArgumentException("Cyclic constructor hierarchy: " + type);
        String parentType = parents.get(type);
        if (parentType == null) throw new IllegalArgumentException("Cannot restore constructor outside APK: " + type + " -> " + owner);
        Bridge parent = parentType.equals(owner) ? null : bridge(parentType, owner, args, visiting);
        var used = signatures.get(type);
        int markers = 1;
        while (!used.add(descriptor(args, markers))) markers++;
        Bridge result = new Bridge(type, owner, args.clone(), descriptor(args, markers), markers, parent);
        bridges.put(key, result);
        visiting.remove(type);
        return result;
    }
    public static InvokeExpr invokeNew(Value[] values, String[] args, String type, String owner) {
        if (type.equals(owner)) return Exprs.nInvokeNew(values, args, type);
        var registry = active;
        if (registry == null) throw new IllegalStateException("Missing constructor conversion registry");
        var bridge = registry.bridge(type, owner, args, new HashSet<>());
        Value[] withMarkers = Arrays.copyOf(values, values.length + bridge.markers);
        String[] argTypes = Arrays.copyOf(args, args.length + bridge.markers);
        for (int i = 0; i < bridge.markers; i++) {
            withMarkers[values.length + i] = Exprs.nNull();
            argTypes[args.length + i] = MARKER;
        }
        return Exprs.nInvokeNew(withMarkers, argTypes, type);
    }
    public ClassVisitor visitor(ClassVisitor output) {
        return new ClassVisitor(Opcodes.ASM9, output) {
            String type;
            @Override public void visit(int version, int access, String name, String signature, String parent, String[] interfaces) {
                type = "L" + name + ";";
                super.visit(version, access, name, signature, parent, interfaces);
            }
            @Override public void visitEnd() {
                for (Bridge bridge : bridges.values()) if (bridge.type.equals(type)) {
                    MethodVisitor mv = super.visitMethod(Opcodes.ACC_PUBLIC | Opcodes.ACC_SYNTHETIC, "<init>", bridge.descriptor, null, null);
                    mv.visitCode(); mv.visitVarInsn(Opcodes.ALOAD, 0);
                    int slot = 1;
                    for (String arg : bridge.args) {
                        Type t = Type.getType(arg);
                        mv.visitVarInsn(t.getOpcode(Opcodes.ILOAD), slot);
                        slot += t.getSize();
                    }
                    int forwardedMarkers = bridge.parent == null ? 0 : bridge.parent.markers;
                    for (int i = 0; i < forwardedMarkers; i++) mv.visitInsn(Opcodes.ACONST_NULL);
                    String parent = parents.get(type);
                    mv.visitMethodInsn(Opcodes.INVOKESPECIAL, parent.substring(1, parent.length() - 1), "<init>",
                        bridge.parent == null ? descriptor(bridge.args, 0) : bridge.parent.descriptor, false);
                    mv.visitInsn(Opcodes.RETURN);
                    mv.visitMaxs(slot + forwardedMarkers, slot + bridge.markers);
                    mv.visitEnd();
                }
                super.visitEnd();
            }
        };
    }
}
