package android.webkit;

@FunctionalInterface
public interface ValueCallback<T> {
    void onReceiveValue(T value);
}
