package android.webkit;

public class RenderProcessGoneDetail {
    private final boolean crashed;
    public RenderProcessGoneDetail() { this(false); }
    public RenderProcessGoneDetail(boolean crashed) { this.crashed = crashed; }
    public boolean didCrash() { return crashed; }
}
