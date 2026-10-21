package suwayomi.browser;

import java.lang.ref.*;
import java.util.concurrent.atomic.AtomicReference;

public final class ReferenceSmoke {
    public static String verify() throws Exception {
        Object value = new Object(), other = new Object();
        ReferenceQueue<Object> queue = new ReferenceQueue<>();
        Reference<?>[] refs = {new WeakReference<>(value, queue), new SoftReference<>(value), new PhantomReference<>(value, queue)};
        for (Reference<?> ref : refs) {
            @SuppressWarnings("unchecked") Reference<Object> typed = (Reference<Object>)ref;
            if (!typed.refersTo(value) || typed.refersTo(other) || typed.refersTo(null)) throw new AssertionError("Reference identity native failed");
            typed.clear();
            if (!typed.refersTo(null) || typed.refersTo(value) || typed.get() != null) throw new AssertionError("Reference clear native failed");
        }
        if (!refs[0].enqueue() || queue.poll() != refs[0] || queue.poll() != null) throw new AssertionError("Explicit reference queue failed");
        ThreadLocal<Object> local = new ThreadLocal<>();
        InheritableThreadLocal<Object> inherited = new InheritableThreadLocal<>();
        local.set(value); inherited.set(value);
        if (local.get() != value) throw new AssertionError("ThreadLocal lost value after set");
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread child = new Thread(() -> {
            try {
                if (local.get() != null || inherited.get() != value) throw new AssertionError("Child thread isolation/inheritance failed");
                local.set(other); inherited.set(other);
                if (local.get() != other || inherited.get() != other) throw new AssertionError("Child set/get failed");
                local.remove();
                if (local.get() != null) throw new AssertionError("ThreadLocal remove failed");
            } catch (Throwable error) { failure.set(error); }
        });
        child.start(); child.join();
        if (failure.get() != null) throw new AssertionError("Child reference probe failed", failure.get());
        if (local.get() != value || inherited.get() != value) throw new AssertionError("Child changed parent's locals");
        local.remove(); inherited.remove();
        Reference.reachabilityFence(value);
        return "Reference identity/clear/queue and ThreadLocal set/get/remove, child isolation and inheritance verified";
    }
}
