package android.webkit;

public final class ConsoleMessage {
    public enum MessageLevel { TIP, LOG, WARNING, ERROR, DEBUG }
    private final String message, sourceId;
    private final int lineNumber;
    private final MessageLevel level;
    public ConsoleMessage(String message, int lineNumber, String sourceId, MessageLevel level) { this.message = message; this.lineNumber = lineNumber; this.sourceId = sourceId; this.level = level; }
    public String message() { return message; }
    public String sourceId() { return sourceId; }
    public int lineNumber() { return lineNumber; }
    public MessageLevel messageLevel() { return level; }
}
