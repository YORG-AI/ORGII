import {
  ANSI,
  formatCommandMessage,
  formatErrorDetail,
  formatErrorMessage,
  formatInfoMessage,
  formatSuccessMessage,
  formatTimestampFromDate,
  formatWatchMessage,
} from "@src/modules/WorkStation/CodeEditor/hooks/gitOutputIntegration/formatters";

describe("formatTimestampFromDate", () => {
  it("formats fixed date with date, time, ms, and ANSI dim+italic+reset", () => {
    const fixedDate = new Date(2025, 0, 15, 10, 30, 45, 123);
    const result = formatTimestampFromDate(fixedDate);

    expect(result).toContain("2025-01-15");
    expect(result).toContain("10:30:45.123");
    expect(result).toContain("\x1b[2m");
    expect(result).toContain("\x1b[3m");
    expect(result).toContain("\x1b[0m");
  });
});

describe("ANSI", () => {
  it("exposes expected escape sequences", () => {
    expect(ANSI.reset).toBe("\x1b[0m");
    expect(ANSI.dim).toBe("\x1b[2m");
    expect(ANSI.italic).toBe("\x1b[3m");
    expect(ANSI.green).toBe("\x1b[32m");
    expect(ANSI.red).toBe("\x1b[31m");
    expect(ANSI.cyan).toBe("\x1b[36m");
    expect(ANSI.yellow).toBe("\x1b[33m");
    expect(ANSI.gray).toBe("\x1b[90m");
  });
});

describe("formatInfoMessage", () => {
  it("includes [info], text, and trailing newline", () => {
    const timestamp = "\x1b[2m\x1b[3m2025-01-01 00:00:00.000\x1b[0m";
    const result = formatInfoMessage(timestamp, "hello");

    expect(result).toContain("[info]");
    expect(result).toContain("hello");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("formatCommandMessage", () => {
  it("includes > prefix before command", () => {
    const timestamp = "ts";
    const result = formatCommandMessage(timestamp, "git status");

    expect(result).toContain("> ");
    expect(result).toContain("git status");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("formatSuccessMessage", () => {
  it("includes checkmark, completed, and duration", () => {
    const result = formatSuccessMessage("ts", "pull", 42);

    expect(result).toContain("✓");
    expect(result).toContain("completed");
    expect(result).toContain("42ms");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("formatErrorMessage", () => {
  it("includes cross, failed, and optional duration", () => {
    const withoutDuration = formatErrorMessage("ts", "push");
    expect(withoutDuration).toContain("✗");
    expect(withoutDuration).toContain("failed");
    expect(withoutDuration).not.toContain("ms");

    const withDuration = formatErrorMessage("ts", "push", 99);
    expect(withDuration).toContain("✗");
    expect(withDuration).toContain("failed");
    expect(withDuration).toContain("99ms");
  });
});

describe("formatErrorDetail", () => {
  it("includes error text", () => {
    const result = formatErrorDetail("ts", "network unreachable");
    expect(result).toContain("network unreachable");
    expect(result).toContain("✗");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("formatWatchMessage", () => {
  it("start mentions watcher started", () => {
    expect(formatWatchMessage("ts", "start")).toContain("watcher started");
  });

  it("change mentions changes detected", () => {
    expect(formatWatchMessage("ts", "change")).toContain("changes detected");
  });

  it("idle mentions no changes", () => {
    expect(formatWatchMessage("ts", "idle")).toContain("No changes");
  });
});
