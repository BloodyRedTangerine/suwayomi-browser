package suwayomi.browser;

import com.googlecode.d2j.Method;
import com.googlecode.d2j.node.DexFileNode;
import com.googlecode.d2j.node.DexMethodNode;
import com.googlecode.d2j.node.insn.DexStmtNode;
import com.googlecode.d2j.node.insn.FieldStmtNode;
import com.googlecode.d2j.node.insn.MethodStmtNode;
import com.googlecode.d2j.node.insn.TypeStmtNode;
import com.googlecode.d2j.reader.MultiDexFileReader;
import java.lang.reflect.Constructor;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.objectweb.asm.Type;

/** Audits Android API references in pinned APK fixtures against the actual host classpath. */
public final class ExtensionAndroidApiAudit {
    private record Reference(String owner, String name, String descriptor) implements Comparable<Reference> {
        @Override public int compareTo(Reference other) {
            return (owner + name + descriptor).compareTo(other.owner + other.name + other.descriptor);
        }
    }
    private record FieldReference(String owner, String name, String descriptor) implements Comparable<FieldReference> {
        @Override public int compareTo(FieldReference other) {
            return (owner + name + descriptor).compareTo(other.owner + other.name + other.descriptor);
        }
    }

    private static boolean isAndroidOwner(String owner) {
        return owner.startsWith("Landroid/") || owner.startsWith("Landroidx/");
    }

    private static Class<?> resolve(Type type, ClassLoader loader) throws ClassNotFoundException {
        return switch (type.getSort()) {
            case Type.VOID -> void.class;
            case Type.BOOLEAN -> boolean.class;
            case Type.CHAR -> char.class;
            case Type.BYTE -> byte.class;
            case Type.SHORT -> short.class;
            case Type.INT -> int.class;
            case Type.FLOAT -> float.class;
            case Type.LONG -> long.class;
            case Type.DOUBLE -> double.class;
            case Type.ARRAY -> Class.forName(type.getDescriptor().replace('/', '.'), false, loader);
            case Type.OBJECT -> Class.forName(type.getClassName(), false, loader);
            default -> throw new IllegalArgumentException("Unsupported JVM descriptor: " + type);
        };
    }

    private static boolean resolves(Class<?> owner, String name, String descriptor) throws ClassNotFoundException {
        Type method = Type.getMethodType(descriptor);
        ClassLoader loader = ExtensionAndroidApiAudit.class.getClassLoader();
        Class<?>[] parameters = new Class<?>[method.getArgumentTypes().length];
        for (int index = 0; index < parameters.length; index++) parameters[index] = resolve(method.getArgumentTypes()[index], loader);
        ArrayDeque<Class<?>> pending = new ArrayDeque<>();
        Set<Class<?>> visited = new HashSet<>();
        pending.add(owner);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!visited.add(current)) continue;
            if (name.equals("<init>")) {
                for (Constructor<?> constructor : current.getDeclaredConstructors())
                    if (java.util.Arrays.equals(constructor.getParameterTypes(), parameters)
                        && Type.getConstructorDescriptor(constructor).equals(descriptor)) return true;
            } else {
                for (java.lang.reflect.Method candidate : current.getDeclaredMethods())
                    if (candidate.getName().equals(name) && Type.getMethodDescriptor(candidate).equals(descriptor)) return true;
            }
            if (current.getSuperclass() != null) pending.add(current.getSuperclass());
            pending.addAll(List.of(current.getInterfaces()));
        }
        return false;
    }

    /** True when the resolved Android SDK entry is concrete code from the compile-only Android JAR. */
    private static boolean isConcreteTarget(Class<?> owner, String name, String descriptor) throws ClassNotFoundException {
        Type method = Type.getMethodType(descriptor);
        ClassLoader loader = ExtensionAndroidApiAudit.class.getClassLoader();
        Class<?>[] parameters = new Class<?>[method.getArgumentTypes().length];
        for (int index = 0; index < parameters.length; index++) parameters[index] = resolve(method.getArgumentTypes()[index], loader);
        ArrayDeque<Class<?>> pending = new ArrayDeque<>();
        Set<Class<?>> visited = new HashSet<>();
        pending.add(owner);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!visited.add(current)) continue;
            if (name.equals("<init>")) {
                for (Constructor<?> constructor : current.getDeclaredConstructors())
                    if (java.util.Arrays.equals(constructor.getParameterTypes(), parameters)
                        && Type.getConstructorDescriptor(constructor).equals(descriptor)) return true;
            } else {
                for (java.lang.reflect.Method candidate : current.getDeclaredMethods())
                    if (candidate.getName().equals(name) && Type.getMethodDescriptor(candidate).equals(descriptor))
                        return !Modifier.isAbstract(candidate.getModifiers());
            }
            if (current.getSuperclass() != null) pending.add(current.getSuperclass());
            pending.addAll(List.of(current.getInterfaces()));
        }
        return false;
    }

    private static boolean resolvesField(Class<?> owner, String name, String descriptor) {
        ArrayDeque<Class<?>> pending = new ArrayDeque<>();
        Set<Class<?>> visited = new HashSet<>();
        pending.add(owner);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!visited.add(current)) continue;
            for (java.lang.reflect.Field candidate : current.getDeclaredFields())
                if (candidate.getName().equals(name) && Type.getDescriptor(candidate.getType()).equals(descriptor)) return true;
            if (current.getSuperclass() != null) pending.add(current.getSuperclass());
            pending.addAll(List.of(current.getInterfaces()));
        }
        return false;
    }

    private static void addTypeDescriptor(Set<String> types, String descriptor) {
        if (descriptor == null) return;
        Type type = Type.getType(descriptor);
        if (type.getSort() == Type.ARRAY) type = type.getElementType();
        if (type.getSort() == Type.OBJECT && isAndroidOwner(type.getDescriptor())) types.add(type.getDescriptor());
    }

    private static void addMethodDescriptorTypes(Set<String> types, String descriptor) {
        Type method = Type.getMethodType(descriptor);
        for (Type argument : method.getArgumentTypes()) addTypeDescriptor(types, argument.getDescriptor());
        addTypeDescriptor(types, method.getReturnType().getDescriptor());
    }

    private static String codeSource(Class<?> type) {
        try {
            var source = type.getProtectionDomain().getCodeSource();
            return source == null ? "bootstrap/unknown" : Path.of(source.getLocation().toURI()).toString();
        } catch (Exception error) { return "unknown:" + error.getClass().getSimpleName(); }
    }

    public static void main(String[] artifacts) throws Exception {
        if (artifacts.length == 0) throw new IllegalArgumentException("Pass one or more APK fixture paths");
        ClassLoader loader = ExtensionAndroidApiAudit.class.getClassLoader();
        for (String artifact : artifacts) {
            DexFileNode dex = new DexFileNode();
            MultiDexFileReader.open(Files.readAllBytes(Path.of(artifact))).accept(dex, 0);
            Set<Reference> references = new java.util.TreeSet<>();
            Set<FieldReference> fieldReferences = new java.util.TreeSet<>();
            Set<String> typeReferences = new java.util.TreeSet<>();
            for (var clazz : dex.clzs) {
                addTypeDescriptor(typeReferences, clazz.superClass);
                if (clazz.interfaceNames != null) for (String interfaceName : clazz.interfaceNames) addTypeDescriptor(typeReferences, interfaceName);
                if (clazz.fields != null) for (var field : clazz.fields) addTypeDescriptor(typeReferences, field.field.getType());
                if (clazz.methods == null) continue;
                for (DexMethodNode method : clazz.methods) {
                    addMethodDescriptorTypes(typeReferences, method.method.getDesc());
                    if (method.codeNode == null || method.codeNode.stmts == null) continue;
                    for (DexStmtNode statement : method.codeNode.stmts) {
                        if (statement instanceof MethodStmtNode invocation) {
                            Method target = invocation.method;
                            if (isAndroidOwner(target.getOwner())) references.add(new Reference(target.getOwner(), target.getName(), target.getDesc()));
                            addMethodDescriptorTypes(typeReferences, target.getDesc());
                            addTypeDescriptor(typeReferences, target.getOwner());
                        } else if (statement instanceof FieldStmtNode access) {
                            var target = access.field;
                            if (isAndroidOwner(target.getOwner())) fieldReferences.add(new FieldReference(target.getOwner(), target.getName(), target.getType()));
                            addTypeDescriptor(typeReferences, target.getOwner());
                            addTypeDescriptor(typeReferences, target.getType());
                        } else if (statement instanceof TypeStmtNode type) addTypeDescriptor(typeReferences, type.type);
                    }
                }
            }

            Map<String, List<Reference>> stubOwnerCalls = new TreeMap<>();
            List<String> missing = new ArrayList<>();
            int resolved = 0;
            for (Reference reference : references) {
                String className = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                try {
                    Class<?> owner = Class.forName(className, false, loader);
                    if (!resolves(owner, reference.name, reference.descriptor)) {
                        missing.add(className + "." + reference.name + reference.descriptor);
                        continue;
                    }
                    resolved++;
                    String source = codeSource(owner);
                    // Exclude abstract declarations such as WebResourceRequest methods,
                    // but include concrete static factories on abstract classes (e.g. ICU).
                    if (source.contains("android-jar-") && isConcreteTarget(owner, reference.name, reference.descriptor))
                        stubOwnerCalls.computeIfAbsent(className, ignored -> new ArrayList<>()).add(reference);
                } catch (ClassNotFoundException | LinkageError error) {
                    missing.add(className + "." + reference.name + reference.descriptor + " [" + error.getClass().getSimpleName() + "]");
                }
            }
            for (Reference reference : references) if (reference.owner.startsWith("Landroid/icu/text/")) {
                String owner = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                System.out.printf("  ICU-REF %s.%s%s%n", owner, reference.name, reference.descriptor);
            }
            for (String descriptor : typeReferences) if (descriptor.startsWith("Landroid/icu/"))
                System.out.printf("  ICU-TYPE %s%n", descriptor.substring(1, descriptor.length() - 1).replace('/', '.'));
            System.out.printf("APK %s: %d unique Android method references; %d resolve; %d missing; %d stub-owned references%n",
                Path.of(artifact).getFileName(), references.size(), resolved, missing.size(), stubOwnerCalls.values().stream().mapToInt(List::size).sum());
            for (var entry : stubOwnerCalls.entrySet()) {
                System.out.printf("  SDK-STUB %s: %d calls%n", entry.getKey(), entry.getValue().size());
                for (Reference reference : entry.getValue())
                    System.out.printf("    %s.%s%s%n", entry.getKey(), reference.name(), reference.descriptor());
            }
            for (String reference : missing) System.out.println("  MISSING " + reference);

            List<String> missingFields = new ArrayList<>();
            for (FieldReference reference : fieldReferences) {
                String className = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                try {
                    if (!resolvesField(Class.forName(className, false, loader), reference.name, reference.descriptor))
                        missingFields.add(className + "." + reference.name + ":" + reference.descriptor);
                } catch (ClassNotFoundException | LinkageError error) {
                    missingFields.add(className + "." + reference.name + ":" + reference.descriptor + " [" + error.getClass().getSimpleName() + "]");
                }
            }
            List<String> missingTypes = new ArrayList<>();
            for (String descriptor : typeReferences) {
                try { resolve(Type.getType(descriptor), loader); }
                catch (ClassNotFoundException | LinkageError error) { missingTypes.add(descriptor + " [" + error.getClass().getSimpleName() + "]"); }
            }
            System.out.printf("  Android fields: %d; missing: %d; Android types: %d; missing: %d%n",
                fieldReferences.size(), missingFields.size(), typeReferences.size(), missingTypes.size());
            for (String field : missingFields) System.out.println("  MISSING-FIELD " + field);
            for (String type : missingTypes) System.out.println("  MISSING-TYPE " + type);
        }
    }
}
