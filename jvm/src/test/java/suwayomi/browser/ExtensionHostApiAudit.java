package suwayomi.browser;

import com.googlecode.d2j.Method;
import com.googlecode.d2j.MethodHandle;
import com.googlecode.d2j.Proto;
import com.googlecode.d2j.node.DexAnnotationNode;
import com.googlecode.d2j.node.DexFileNode;
import com.googlecode.d2j.node.DexMethodNode;
import com.googlecode.d2j.node.insn.ConstStmtNode;
import com.googlecode.d2j.node.insn.DexStmtNode;
import com.googlecode.d2j.node.insn.FieldStmtNode;
import com.googlecode.d2j.node.insn.MethodCustomStmtNode;
import com.googlecode.d2j.node.insn.MethodPolymorphicStmtNode;
import com.googlecode.d2j.node.insn.MethodStmtNode;
import com.googlecode.d2j.node.insn.Stmt1RNode;
import com.googlecode.d2j.node.insn.Stmt2RNode;
import com.googlecode.d2j.node.insn.TypeStmtNode;
import com.googlecode.d2j.reader.MultiDexFileReader;
import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.objectweb.asm.Type;

/**
 * Checks external DEX references against the browser JVM's host/dependency classpath without executing the APK.
 * Reflection coverage is limited to straight-line literal/register flows for Class.forName, ClassLoader.loadClass,
 * and Class method/field lookup names; dynamically composed names are not claimed.
 */
public final class ExtensionHostApiAudit {
    private record MethodReference(String owner, String name, String descriptor) implements Comparable<MethodReference> {
        @Override public int compareTo(MethodReference other) {
            return (owner + name + descriptor).compareTo(other.owner + other.name + other.descriptor);
        }
    }
    private record FieldReference(String owner, String name, String descriptor) implements Comparable<FieldReference> {
        @Override public int compareTo(FieldReference other) {
            return (owner + name + descriptor).compareTo(other.owner + other.name + other.descriptor);
        }
    }
    private record NamedReference(String owner, String name) implements Comparable<NamedReference> {
        @Override public int compareTo(NamedReference other) {
            return (owner + name).compareTo(other.owner + other.name);
        }
    }

    private static boolean isDefinedInApk(String owner, Set<String> apkTypes) { return apkTypes.contains(owner); }

    private static void addMethodReference(Set<MethodReference> methods, Set<String> types, Method target, Set<String> apkTypes) {
        if (!isDefinedInApk(target.getOwner(), apkTypes))
            methods.add(new MethodReference(target.getOwner(), target.getName(), target.getDesc()));
        addMethodTypes(types, target.getDesc());
        addType(types, target.getOwner());
    }

    private static void addFieldReference(Set<FieldReference> fields, Set<String> types,
            com.googlecode.d2j.Field target, Set<String> apkTypes) {
        if (!isDefinedInApk(target.getOwner(), apkTypes))
            fields.add(new FieldReference(target.getOwner(), target.getName(), target.getType()));
        addType(types, target.getOwner());
        addType(types, target.getType());
    }

    private static void addMethodHandle(Set<MethodReference> methods, Set<FieldReference> fields,
            Set<String> types, MethodHandle handle, Set<String> apkTypes) {
        if (handle == null) return;
        if (handle.getMethod() != null) addMethodReference(methods, types, handle.getMethod(), apkTypes);
        if (handle.getField() != null) addFieldReference(fields, types, handle.getField(), apkTypes);
    }

    private static void addProtoTypes(Set<String> types, Proto proto) {
        if (proto == null) return;
        for (String parameter : proto.getParameterTypes()) addType(types, parameter);
        addType(types, proto.getReturnType());
    }

    private static void addType(Set<String> types, String descriptor) {
        if (descriptor == null) return;
        Type type = Type.getType(descriptor);
        if (type.getSort() == Type.ARRAY) type = type.getElementType();
        if (type.getSort() == Type.OBJECT) types.add(type.getDescriptor());
    }

    private static void addMethodTypes(Set<String> types, String descriptor) {
        Type method = Type.getMethodType(descriptor);
        for (Type argument : method.getArgumentTypes()) addType(types, argument.getDescriptor());
        addType(types, method.getReturnType().getDescriptor());
    }

    private static void addAnnotationValue(Set<MethodReference> methods, Set<FieldReference> fields,
            Set<String> types, Set<String> apkTypes, Object value) {
        if (value instanceof DexAnnotationNode annotation) {
            addAnnotation(methods, fields, types, apkTypes, annotation);
        } else if (value instanceof Object[] values) {
            for (Object item : values) addAnnotationValue(methods, fields, types, apkTypes, item);
        } else if (value instanceof com.googlecode.d2j.Field field) {
            addFieldReference(fields, types, field, apkTypes);
        } else if (value instanceof String descriptor
                && (descriptor.startsWith("L") && descriptor.endsWith(";") || descriptor.startsWith("["))) {
            addType(types, descriptor);
        }
    }

    private static void addAnnotation(Set<MethodReference> methods, Set<FieldReference> fields,
            Set<String> types, Set<String> apkTypes, DexAnnotationNode annotation) {
        if (annotation == null) return;
        // DEX SYSTEM annotations describe compiler/runtime metadata; they are not APK linkage dependencies.
        if (annotation.visibility == com.googlecode.d2j.Visibility.SYSTEM
                && annotation.type.startsWith("Ldalvik/annotation/")) return;
        addType(types, annotation.type);
        if (annotation.items != null) for (DexAnnotationNode.Item item : annotation.items)
            addAnnotationValue(methods, fields, types, apkTypes, item.value);
    }

    private static void addAnnotations(Set<MethodReference> methods, Set<FieldReference> fields,
            Set<String> types, Set<String> apkTypes, List<DexAnnotationNode> annotations) {
        if (annotations != null) for (DexAnnotationNode annotation : annotations)
            addAnnotation(methods, fields, types, apkTypes, annotation);
    }

    private static String reflectedType(String name) {
        if (name == null) return null;
        String value = name.trim();
        if (value.startsWith("[")) {
            String descriptor = value.replace('.', '/');
            try { return Type.getType(descriptor).getSort() == Type.ARRAY ? descriptor : null; }
            catch (IllegalArgumentException ignored) { return null; }
        }
        if (value.startsWith("L") && value.endsWith(";")) {
            try { return Type.getType(value).getSort() == Type.OBJECT ? value : null; }
            catch (IllegalArgumentException ignored) { return null; }
        }
        if (!value.matches("[A-Za-z_$][A-Za-z0-9_$]*(?:[./][A-Za-z_$][A-Za-z0-9_$]*)+")) return null;
        return "L" + value.replace('.', '/') + ";";
    }

    private static boolean resolvesMethodName(Class<?> owner, String name) {
        ArrayDeque<Class<?>> pending = new ArrayDeque<>();
        Set<Class<?>> visited = new HashSet<>();
        pending.add(owner);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!visited.add(current)) continue;
            for (java.lang.reflect.Method candidate : current.getDeclaredMethods())
                if (candidate.getName().equals(name)) return true;
            if (current.getSuperclass() != null) pending.add(current.getSuperclass());
            pending.addAll(List.of(current.getInterfaces()));
        }
        return false;
    }

    private static boolean resolvesFieldName(Class<?> owner, String name) {
        ArrayDeque<Class<?>> pending = new ArrayDeque<>();
        Set<Class<?>> visited = new HashSet<>();
        pending.add(owner);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!visited.add(current)) continue;
            for (var candidate : current.getDeclaredFields()) if (candidate.getName().equals(name)) return true;
            if (current.getSuperclass() != null) pending.add(current.getSuperclass());
            pending.addAll(List.of(current.getInterfaces()));
        }
        return false;
    }

    private static Class<?> resolveType(Type type, ClassLoader loader) throws ClassNotFoundException {
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

    private static boolean resolvesMethod(Class<?> owner, String name, String descriptor) {
        ArrayDeque<Class<?>> pending = new ArrayDeque<>();
        Set<Class<?>> visited = new HashSet<>();
        pending.add(owner);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!visited.add(current)) continue;
            if (name.equals("<init>")) {
                for (Constructor<?> constructor : current.getDeclaredConstructors())
                    if (Type.getConstructorDescriptor(constructor).equals(descriptor)) return true;
            } else {
                for (java.lang.reflect.Method candidate : current.getDeclaredMethods())
                    if (candidate.getName().equals(name) && Type.getMethodDescriptor(candidate).equals(descriptor)) return true;
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
            for (var candidate : current.getDeclaredFields())
                if (candidate.getName().equals(name) && Type.getDescriptor(candidate.getType()).equals(descriptor)) return true;
            if (current.getSuperclass() != null) pending.add(current.getSuperclass());
            pending.addAll(List.of(current.getInterfaces()));
        }
        return false;
    }

    public static void main(String... artifacts) throws Exception {
        if (artifacts.length == 0) throw new IllegalArgumentException("Pass one or more APK fixture paths");
        ClassLoader loader = ExtensionHostApiAudit.class.getClassLoader();
        for (String artifact : artifacts) {
            DexFileNode dex = new DexFileNode();
            MultiDexFileReader.open(Files.readAllBytes(Path.of(artifact))).accept(dex, 0);
            Set<String> apkTypes = new HashSet<>();
            for (var clazz : dex.clzs) apkTypes.add(clazz.className);

            Set<MethodReference> methods = new TreeSet<>();
            Set<FieldReference> fields = new TreeSet<>();
            Set<String> types = new TreeSet<>();
            Set<String> reflectedClasses = new TreeSet<>();
            Set<NamedReference> reflectedMethods = new TreeSet<>();
            Set<NamedReference> reflectedFields = new TreeSet<>();
            int customInvocations = 0;
            int polymorphicInvocations = 0;
            int staticInitializers = 0;
            for (var clazz : dex.clzs) {
                addType(types, clazz.superClass);
                if (clazz.interfaceNames != null) for (String name : clazz.interfaceNames) addType(types, name);
                addAnnotations(methods, fields, types, apkTypes, clazz.anns);
                if (clazz.fields != null) for (var field : clazz.fields) {
                    addType(types, field.field.getType());
                    addAnnotations(methods, fields, types, apkTypes, field.anns);
                }
                if (clazz.methods == null) continue;
                for (DexMethodNode method : clazz.methods) {
                    if (method.method.getName().equals("<clinit>")) staticInitializers++;
                    addMethodTypes(types, method.method.getDesc());
                    addAnnotations(methods, fields, types, apkTypes, method.anns);
                    if (method.parameterAnns != null) for (List<DexAnnotationNode> annotations : method.parameterAnns)
                        addAnnotations(methods, fields, types, apkTypes, annotations);
                    if (method.codeNode == null || method.codeNode.stmts == null) continue;
                    Map<Integer, String> strings = new HashMap<>();
                    Map<Integer, String> classTypes = new HashMap<>();
                    String pendingClassResult = null;
                    for (DexStmtNode statement : method.codeNode.stmts) {
                        if (statement instanceof ConstStmtNode constant) {
                            strings.remove(constant.a); classTypes.remove(constant.a); pendingClassResult = null;
                            if ((constant.op == com.googlecode.d2j.reader.Op.CONST_STRING
                                    || constant.op == com.googlecode.d2j.reader.Op.CONST_STRING_JUMBO)
                                    && constant.value instanceof String value) strings.put(constant.a, value);
                        } else if (statement instanceof Stmt2RNode move) {
                            String string = strings.get(move.b), type = classTypes.get(move.b);
                            strings.remove(move.a); classTypes.remove(move.a); pendingClassResult = null;
                            if (move.op == com.googlecode.d2j.reader.Op.MOVE_OBJECT
                                    || move.op == com.googlecode.d2j.reader.Op.MOVE_OBJECT_FROM16
                                    || move.op == com.googlecode.d2j.reader.Op.MOVE_OBJECT_16) {
                                if (string != null) strings.put(move.a, string);
                                if (type != null) classTypes.put(move.a, type);
                            }
                        } else if (statement instanceof Stmt1RNode move) {
                            strings.remove(move.a); classTypes.remove(move.a);
                            if (move.op == com.googlecode.d2j.reader.Op.MOVE_RESULT_OBJECT && pendingClassResult != null)
                                classTypes.put(move.a, pendingClassResult);
                            pendingClassResult = null;
                        } else if (statement instanceof TypeStmtNode type) {
                            strings.remove(type.a); classTypes.remove(type.a); pendingClassResult = null;
                            if (type.op == com.googlecode.d2j.reader.Op.CONST_CLASS) classTypes.put(type.a, type.type);
                            addType(types, type.type);
                        } else if (statement instanceof FieldStmtNode access) {
                            if (access.op.name().startsWith("IGET") || access.op.name().startsWith("SGET")) {
                                strings.remove(access.a); classTypes.remove(access.a);
                            }
                            pendingClassResult = null;
                            addFieldReference(fields, types, access.field, apkTypes);
                        } else if (statement instanceof MethodStmtNode invocation) {
                            addMethodReference(methods, types, invocation.method, apkTypes);
                            Method target = invocation.method;
                            int[] arguments = invocation.args;
                            pendingClassResult = null;
                            if (target.getOwner().equals("Ljava/lang/Class;") && target.getName().equals("forName") && arguments.length > 0) {
                                pendingClassResult = reflectedType(strings.get(arguments[0]));
                                if (pendingClassResult != null && !isDefinedInApk(pendingClassResult, apkTypes)) reflectedClasses.add(pendingClassResult);
                                addType(types, pendingClassResult);
                            } else if (target.getOwner().equals("Ljava/lang/ClassLoader;") && target.getName().equals("loadClass") && arguments.length > 1) {
                                pendingClassResult = reflectedType(strings.get(arguments[1]));
                                if (pendingClassResult != null && !isDefinedInApk(pendingClassResult, apkTypes)) reflectedClasses.add(pendingClassResult);
                                addType(types, pendingClassResult);
                            } else if (target.getOwner().equals("Ljava/lang/Class;") && arguments.length > 1) {
                                String owner = classTypes.get(arguments[0]);
                                String memberName = strings.get(arguments[1]);
                                if (owner != null && memberName != null && !isDefinedInApk(owner, apkTypes)) {
                                    if (target.getName().equals("getMethod") || target.getName().equals("getDeclaredMethod"))
                                        reflectedMethods.add(new NamedReference(owner, memberName));
                                    if (target.getName().equals("getField") || target.getName().equals("getDeclaredField"))
                                        reflectedFields.add(new NamedReference(owner, memberName));
                                }
                            }
                        } else if (statement instanceof MethodPolymorphicStmtNode invocation) {
                            pendingClassResult = null;
                            polymorphicInvocations++;
                            addMethodReference(methods, types, invocation.method, apkTypes);
                            addProtoTypes(types, invocation.proto);
                        } else if (statement instanceof MethodCustomStmtNode invocation) {
                            pendingClassResult = null;
                            customInvocations++;
                            var callSite = invocation.callSite;
                            addMethodHandle(methods, fields, types, callSite.getBootstrapMethodHandler(), apkTypes);
                            addProtoTypes(types, callSite.getMethodProto());
                            for (Object argument : callSite.getExtraArguments()) {
                                if (argument instanceof MethodHandle handle)
                                    addMethodHandle(methods, fields, types, handle, apkTypes);
                                else if (argument instanceof Proto proto) addProtoTypes(types, proto);
                            }
                        } else pendingClassResult = null;
                    }
                }
            }

            List<String> missingMethods = new ArrayList<>();
            int resolvedMethods = 0;
            for (MethodReference reference : methods) {
                try {
                    String ownerName = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                    if (resolvesMethod(Class.forName(ownerName, false, loader), reference.name, reference.descriptor)) resolvedMethods++;
                    else missingMethods.add(ownerName + "." + reference.name + reference.descriptor);
                } catch (ClassNotFoundException | LinkageError error) {
                    missingMethods.add(reference.owner + "." + reference.name + reference.descriptor + " [" + error.getClass().getSimpleName() + "]");
                }
            }

            List<String> missingFields = new ArrayList<>();
            int resolvedFields = 0;
            for (FieldReference reference : fields) {
                try {
                    String ownerName = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                    if (resolvesField(Class.forName(ownerName, false, loader), reference.name, reference.descriptor)) resolvedFields++;
                    else missingFields.add(ownerName + "." + reference.name + ":" + reference.descriptor);
                } catch (ClassNotFoundException | LinkageError error) {
                    missingFields.add(reference.owner + "." + reference.name + ":" + reference.descriptor + " [" + error.getClass().getSimpleName() + "]");
                }
            }

            List<String> missingTypes = new ArrayList<>();
            int resolvedTypes = 0;
            for (String descriptor : types) {
                if (apkTypes.contains(descriptor)) continue;
                try { resolveType(Type.getType(descriptor), loader); resolvedTypes++; }
                catch (ClassNotFoundException | LinkageError error) { missingTypes.add(descriptor + " [" + error.getClass().getSimpleName() + "]"); }
            }

            List<String> missingReflectedMembers = new ArrayList<>();
            for (NamedReference reference : reflectedMethods) {
                try {
                    String ownerName = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                    if (!resolvesMethodName(Class.forName(ownerName, false, loader), reference.name))
                        missingReflectedMembers.add(ownerName + "." + reference.name + " [reflective method]");
                } catch (ClassNotFoundException | LinkageError error) {
                    missingReflectedMembers.add(reference.owner + "." + reference.name + " [reflective method, " + error.getClass().getSimpleName() + "]");
                }
            }
            for (NamedReference reference : reflectedFields) {
                try {
                    String ownerName = reference.owner.substring(1, reference.owner.length() - 1).replace('/', '.');
                    if (!resolvesFieldName(Class.forName(ownerName, false, loader), reference.name))
                        missingReflectedMembers.add(ownerName + "." + reference.name + " [reflective field]");
                } catch (ClassNotFoundException | LinkageError error) {
                    missingReflectedMembers.add(reference.owner + "." + reference.name + " [reflective field, " + error.getClass().getSimpleName() + "]");
                }
            }

            System.out.printf("APK %s: external methods %d/%d, fields %d/%d, types %d/%d resolve%n",
                Path.of(artifact).getFileName(), resolvedMethods, methods.size(), resolvedFields, fields.size(), resolvedTypes, resolvedTypes + missingTypes.size());
            System.out.printf("  DEX dynamic invokes: %d custom, %d polymorphic; static initializers scanned: %d%n", customInvocations, polymorphicInvocations, staticInitializers);
            System.out.printf("  Constant reflective lookups: %d classes, %d method names, %d field names; unresolved members: %d%n",
                reflectedClasses.size(), reflectedMethods.size(), reflectedFields.size(), missingReflectedMembers.size());
            for (String descriptor : reflectedClasses) System.out.println("  REFLECTIVE-CLASS " + descriptor);
            for (String reference : missingMethods) System.out.println("  MISSING-METHOD " + reference);
            for (String reference : missingFields) System.out.println("  MISSING-FIELD " + reference);
            for (String reference : missingTypes) System.out.println("  MISSING-TYPE " + reference);
            for (String reference : missingReflectedMembers) System.out.println("  MISSING-REFLECTIVE-MEMBER " + reference);
        }
    }
}
